import SwiftUI

/// App entry point. Registers the push-handling app delegate and shows the
/// Today/Review/Deadlines tab shell.
@main
struct StudentOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
