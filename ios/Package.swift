// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FKPhotos",
    platforms: [
        .iOS(.v18),
    ],
    products: [
        .library(name: "FKPhotosLib", targets: ["FKPhotosLib"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.4.0"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.0.2"),
    ],
    targets: [
        .target(
            name: "FKPhotosLib",
            dependencies: [
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
            dependencies: ["FKPhotosLib"],
            path: "Tests/FKPhotosTests",
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
