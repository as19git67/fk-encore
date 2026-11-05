// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FKPhotos",
    platforms: [
        .iOS(.v18),
    ],
    products: [
        .library(name: "FKPhotosLib", targets: ["FKPhotosLib"]),
        // What every app built here shares; a later Finance or Documents
        // app links this without `FKPhotosLib`.
        .library(name: "F4milCore", targets: ["F4milCore"]),
        // The assistant: chat, stream, generic rows. Knows no app; the app
        // hands in what it opens itself (`AssistantHost`).
        .library(name: "F4milAssistant", targets: ["F4milAssistant"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.4.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.2"),
    ],
    targets: [
        // The session, the API client, the keychain, the App Group storage
        // and the deep-link catalog (documentation/plans/assistent-ios.md,
        // stage 2). Knows no module's models: every request is generic over
        // its reply, and what an app does around a sign-out it hands in as
        // closures. The assistant package of stage 3 and any later app sit on
        // this; `FKPhotosLib` re-exports it so its own files need no import.
        .target(
            name: "F4milCore",
            path: "Sources/F4milCore",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        // The KI-Assistent as a package of its own (plan, stage 3): the
        // conversations, the chat screen, the WebSocket that watches a turn,
        // and one generic row drawn from the server's `display`. It sits on
        // `F4milCore` only, so a Finance or Documents app links it without
        // the Photos app; what an app shows natively it hands in at start.
        .target(
            name: "F4milAssistant",
            dependencies: ["F4milCore"],
            path: "Sources/F4milAssistant",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        .target(
            name: "FKPhotosLib",
            dependencies: [
                "F4milCore",
                "F4milAssistant",
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ],
            path: "Sources/FKPhotos",
            exclude: ["Info.plist"],
            resources: [
                .process("Resources")
            ],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ],
            plugins: [
                .plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator"),
            ]
        ),
        .testTarget(
            name: "FKPhotosTests",
            dependencies: ["FKPhotosLib", "F4milCore"],
            path: "Tests/FKPhotosTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        // The assistant's reading of the stream and of the blocks, held
        // against the shapes the server writes — the one place a drift
        // between web and phone would show before a device does.
        .testTarget(
            name: "F4milAssistantTests",
            dependencies: ["F4milAssistant", "F4milCore"],
            path: "Tests/F4milAssistantTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        // The share extension's wire types, borrowed into the package.
        //
        // `F4milShare/` is an app-extension target of the .xcodeproj and
        // cannot be a package target: it needs UIKit, an App Group and a
        // host app. But the types it decodes into need none of those, so
        // this compiles that one file a second time — the extension
        // still builds it as part of its own target — and gives the
        // tests below something to import.
        //
        // Why bother: CI compiles the extension, and compiling cannot
        // catch a `Decodable` that asks for a field the server never
        // sends. That failure happens inside a `JSONDecoder` on a
        // device, and it cost the idea collection months of being
        // unreachable from the share sheet.
        //
        // `sources` names the one file deliberately. Everything else in
        // that folder belongs to the extension alone.
        .target(
            name: "F4milShareWire",
            path: "F4milShare",
            exclude: [
                "ShareAuth.swift",
                "ShareExtension.entitlements",
                "ShareExtensionAPI.swift",
                "ShareProposalsView.swift",
                "ShareViewController.swift",
                "TripShareCapture.swift",
                "TripSharePageReading.js",
                "TripSharePayload.swift",
            ],
            sources: ["ShareWireTypes.swift"],
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
        .testTarget(
            name: "F4milShareWireTests",
            dependencies: ["F4milShareWire"],
            path: "Tests/F4milShareWireTests",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
