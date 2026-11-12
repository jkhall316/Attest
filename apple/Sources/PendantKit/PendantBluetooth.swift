#if canImport(CoreBluetooth)
import CoreBluetooth
import Foundation

public enum PendantBluetoothError: Error, LocalizedError {
    case unavailable(String)
    case notFound
    case failed(String)
    public var errorDescription: String? {
        switch self {
        case .unavailable(let why): return why
        case .notFound: return "No Limitless pendant found nearby. If it is connected to another app (such as Omi), turn Bluetooth off there first: a pendant talks to one phone at a time."
        case .failed(let why): return why
        }
    }
}

/// The real Bluetooth link to a Limitless pendant (CoreBluetooth; the same code serves macOS and iOS).
/// Service and characteristic ids are the pendant's own (see LimitlessProtocol). It needs no pairing
/// step beyond connect + subscribe.
public final class PendantBluetooth: NSObject, PendantLink, CBCentralManagerDelegate, CBPeripheralDelegate {
    public static let service = CBUUID(string: "632DE001-604C-446B-A80F-7963E950F3FB")
    static let txUUID = CBUUID(string: "632DE002-604C-446B-A80F-7963E950F3FB")
    static let rxUUID = CBUUID(string: "632DE003-604C-446B-A80F-7963E950F3FB")

    public struct Found: Equatable { public var id: UUID; public var name: String; public var rssi: Int }

    private var central: CBCentralManager!
    private var peripheral: CBPeripheral?
    private var tx: CBCharacteristic?
    private var rx: CBCharacteristic?
    private let packets = PacketQueue()

    private var poweredOn: CheckedContinuation<Void, Error>?
    private var connecting: CheckedContinuation<Void, Error>?
    private var writing: CheckedContinuation<Void, Error>?
    private var found: [UUID: Found] = [:]
    private var scanFilter: ((CBPeripheral, [String: Any]) -> Bool)?
    private var scanHits: [UUID: CBPeripheral] = [:]
    private var pendingTarget: UUID?
    private var onFound: ((Found) -> Void)?

    /// Fired when a connection that WE did not start from an `await connect` becomes ready: the pendant came
    /// back into range while armed (see `keepConnected`), possibly after iOS relaunched the app for it.
    public var onReady: (() -> Void)?
    private var autoReconnect = false
    private var restored: CBPeripheral?

    /// `restoreIdentifier` lets iOS relaunch the app in the background when a known pendant reconnects.
    public init(restoreIdentifier: String? = nil) {
        super.init()
        var opts: [String: Any] = [:]
        if let r = restoreIdentifier { opts[CBCentralManagerOptionRestoreIdentifierKey] = r }
        central = CBCentralManager(delegate: self, queue: nil, options: opts)
    }

    private func waitPoweredOn() async throws {
        switch central.state {
        case .poweredOn: return
        case .unauthorized: throw PendantBluetoothError.unavailable("Bluetooth permission is off for this app. Turn it on in Settings > Privacy > Bluetooth.")
        case .poweredOff: throw PendantBluetoothError.unavailable("Bluetooth is turned off.")
        case .unsupported: throw PendantBluetoothError.unavailable("This device cannot use Bluetooth LE.")
        default:
            try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in poweredOn = c }
        }
    }

    // MARK: - discovery

    static func looksLikePendant(_ p: CBPeripheral, _ ad: [String: Any]) -> Bool {
        let name = (p.name ?? ad[CBAdvertisementDataLocalNameKey] as? String ?? "").lowercased()
        let uuids = ad[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID] ?? []
        return name.contains("limitless") || name.contains("pendant") || uuids.contains(service)
    }

    /// Pendants advertising nearby, for `seconds`.
    public func scan(seconds: TimeInterval = 8, onFound: ((Found) -> Void)? = nil) async throws -> [Found] {
        try await waitPoweredOn()
        found = [:]; scanHits = [:]; self.onFound = onFound
        scanFilter = { p, ad in PendantBluetooth.looksLikePendant(p, ad) }
        central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
        try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        central.stopScan()
        scanFilter = nil
        return Array(found.values).sorted { $0.rssi > $1.rssi }
    }

    /// Connect to a known pendant by the id `scan` returned (or the first one found if `id` is nil),
    /// find its characteristics and subscribe. Returns the id to remember for next time.
    @discardableResult
    public func connect(id: UUID?, timeout: TimeInterval = 20) async throws -> UUID {
        try await waitPoweredOn()
        packets.clear()
        var target: CBPeripheral?
        if let id { target = central.retrievePeripherals(withIdentifiers: [id]).first }
        if target == nil {
            let hits = try await scan(seconds: min(timeout, 10))
            guard let pick = (id.flatMap { want in hits.first { $0.id == want } } ?? hits.first), let p = scanHits[pick.id] else {
                throw PendantBluetoothError.notFound
            }
            target = p
        }
        guard let p = target else { throw PendantBluetoothError.notFound }
        peripheral = p
        p.delegate = self
        // Already connected and subscribed (an armed background connection): nothing to wait for.
        if p.state == .connected, tx != nil, rx?.isNotifying == true { return p.identifier }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            connecting = c
            central.connect(p, options: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { [weak self] in
                guard let self, let c = self.connecting else { return }
                self.connecting = nil
                self.central.cancelPeripheralConnection(p)
                c.resume(throwing: PendantBluetoothError.failed("Timed out connecting to the pendant."))
            }
        }
        return p.identifier
    }

    /// Arm background sync: ask iOS to connect to this pendant whenever it is in range, with no timeout.
    /// iOS keeps the request alive while the app is suspended, relaunches the app when it succeeds, and
    /// `onReady` fires. Reconnects by itself after every disconnect until `disconnect()`.
    public func keepConnected(id: UUID) {
        autoReconnect = true
        Task { @MainActor in
            try? await self.waitPoweredOn()
            guard let p = self.peripheral ?? self.central.retrievePeripherals(withIdentifiers: [id]).first else { return }
            self.peripheral = p
            p.delegate = self
            self.armConnection(p)
        }
    }

    private func armConnection(_ p: CBPeripheral) {
        switch p.state {
        case .connected: p.discoverServices([PendantBluetooth.service]) // already here (e.g. restored): get the characteristics
        case .connecting: break
        default: central.connect(p, options: nil) // pending: no timeout
        }
    }

    public func disconnect() {
        autoReconnect = false
        if let p = peripheral { central.cancelPeripheralConnection(p) }
        peripheral = nil; tx = nil; rx = nil
    }

    // MARK: - PendantLink

    public func send(_ data: Data) async throws {
        guard let p = peripheral, let tx else { throw PendantBluetoothError.failed("Not connected to the pendant.") }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            writing = c
            p.writeValue(data, for: tx, type: .withResponse)
        }
    }

    public func nextPacket(timeout: TimeInterval) async -> Data? { await packets.next(timeout: timeout) }

    // MARK: - CBCentralManagerDelegate

    public func centralManagerDidUpdateState(_ c: CBCentralManager) {
        if c.state == .poweredOn {
            poweredOn?.resume(); poweredOn = nil
            // iOS relaunched us for this pendant: carry on where the previous process left off.
            if let r = restored { restored = nil; peripheral = r; r.delegate = self; armConnection(r) }
        }
        else if c.state != .unknown && c.state != .resetting, let w = poweredOn {
            poweredOn = nil
            w.resume(throwing: PendantBluetoothError.unavailable(c.state == .unauthorized
                ? "Bluetooth permission is off for this app." : "Bluetooth is not available."))
        }
    }

    public func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral, advertisementData ad: [String: Any], rssi: NSNumber) {
        guard scanFilter?(p, ad) == true else { return }
        let f = Found(id: p.identifier, name: p.name ?? "Limitless pendant", rssi: rssi.intValue)
        found[p.identifier] = f
        scanHits[p.identifier] = p
        onFound?(f)
    }

    /// iOS relaunched the app in the background because a pending connection to the pendant completed (or
    /// it was connected when we were killed). Remember the peripheral; we resume once Bluetooth reports powered on.
    public func centralManager(_ c: CBCentralManager, willRestoreState dict: [String: Any]) {
        if let p = (dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral])?.first {
            autoReconnect = true
            restored = p
            if c.state == .poweredOn { restored = nil; peripheral = p; p.delegate = self; armConnection(p) }
        }
    }

    public func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        p.discoverServices([PendantBluetooth.service])
    }
    public func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        connecting?.resume(throwing: PendantBluetoothError.failed(error?.localizedDescription ?? "Could not connect."))
        connecting = nil
    }
    public func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        let e = PendantBluetoothError.failed(error?.localizedDescription ?? "The pendant disconnected.")
        connecting?.resume(throwing: e); connecting = nil
        writing?.resume(throwing: e); writing = nil
        if autoReconnect { central.connect(p, options: nil) } // out of range or switched off: wait for it to return
    }

    // MARK: - CBPeripheralDelegate

    public func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = p.services?.first(where: { $0.uuid == PendantBluetooth.service }) else {
            fail(error ?? PendantBluetoothError.failed("This device does not have the pendant's service.")); return
        }
        p.discoverCharacteristics([PendantBluetooth.txUUID, PendantBluetooth.rxUUID], for: s)
    }

    public func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor s: CBService, error: Error?) {
        tx = s.characteristics?.first { $0.uuid == PendantBluetooth.txUUID }
        rx = s.characteristics?.first { $0.uuid == PendantBluetooth.rxUUID }
        guard tx != nil, let rx else { fail(error ?? PendantBluetoothError.failed("The pendant's characteristics were not found.")); return }
        p.setNotifyValue(true, for: rx)
    }

    public func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        if let error { fail(error); return }
        guard ch.uuid == PendantBluetooth.rxUUID, ch.isNotifying else { return }
        if let c = connecting { c.resume(); connecting = nil } // an `await connect` is waiting
        else { onReady?() }                                      // armed connection came up by itself
    }

    public func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        if ch.uuid == PendantBluetooth.rxUUID, let v = ch.value { packets.push(Data(v)) }
    }

    public func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        if let error { writing?.resume(throwing: error) } else { writing?.resume() }
        writing = nil
    }

    private func fail(_ e: Error) { connecting?.resume(throwing: e); connecting = nil }
}
#endif
