import SwiftUI
import BackgroundTasks

/// The app delegate exists for the launches that have no screen: iOS relaunching us because the pendant came
/// back in range, because uploads finished, or because a scheduled task is due.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Must be registered before this method returns.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: PendantModel.taskIdentifier, using: nil) { task in
            Self.scheduleNext()
            let work = Task { @MainActor in
                await PendantModel.shared.backgroundSync(connect: true)
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel() }
        }
        Task { @MainActor in PendantModel.shared.startBackground() }
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        Task { @MainActor in
            PendantModel.shared.startBackground() // re-attach to the session before iOS reports its results
            PendantModel.shared.setBackgroundCompletion(completionHandler)
        }
    }

    /// iOS decides when this actually runs (typically while charging, on Wi-Fi, overnight): a catch-up, not a schedule.
    static func scheduleNext() {
        let req = BGProcessingTaskRequest(identifier: PendantModel.taskIdentifier)
        req.requiresNetworkConnectivity = true
        req.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        try? BGTaskScheduler.shared.submit(req)
    }
}

@main
struct AttestApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup { RootView() }
            .onChange(of: phase) { p in if p == .background { AppDelegate.scheduleNext() } }
    }
}
