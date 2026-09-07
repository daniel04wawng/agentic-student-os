import SwiftUI

/// Tab shell for the app. The in-app lists are the authoritative world state;
/// push notifications are only a delivery hint on top.
struct RootView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max") }
            ReviewView()
                .tabItem { Label("Review", systemImage: "tray.full") }
            DeadlinesView()
                .tabItem { Label("Deadlines", systemImage: "calendar") }
            ContentView()
                .tabItem { Label("Status", systemImage: "gauge") }
        }
    }
}

#Preview {
    RootView()
}
