import SwiftUI

/// App entry point. Registers the push-handling app delegate, gates the app on
/// sign-in (LoginView when signed out, the tab shell when signed in), and keeps
/// the access token fresh on launch and when returning to the foreground.
@main
struct StudentOSApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var auth = AuthStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            Group {
                // Skip the gate until auth is turned on (AuthRequired), so this
                // build can ship before the backend/Apple setup without lock-out.
                if !AppConfig.authRequired || auth.isSignedIn {
                    RootView()
                } else {
                    LoginView()
                }
            }
            .environmentObject(auth)
            .task { await auth.refreshIfNeeded() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await auth.refreshIfNeeded() } }
        }
    }
}
