// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Pendant",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "PendantKit", targets: ["PendantKit"]),
        .executable(name: "attest-pendant", targets: ["attest-pendant"]),
    ],
    targets: [
        .target(name: "PendantKit"),
        .executableTarget(name: "attest-pendant", dependencies: ["PendantKit"]),
        .testTarget(name: "PendantKitTests", dependencies: ["PendantKit"], resources: [.copy("Fixtures")]),
    ]
)
