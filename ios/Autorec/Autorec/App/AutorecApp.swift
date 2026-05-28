import SwiftUI

@main
struct AutorecApp: App {
    @State private var serverConfig = ServerConfig.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(serverConfig)
        }
    }
}
