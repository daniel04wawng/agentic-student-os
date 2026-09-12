import SwiftUI

/// Tab shell for the app. The in-app lists are the authoritative world state;
/// push notifications are only a delivery hint on top.
struct RootView: View {
    var body: some View {
        TabView {
            TodayView()
                .tabItem { Label("Today", systemImage: "sun.max") }
            PrepView()
                .tabItem { Label("Prep", systemImage: "graduationcap") }
            DeadlinesView()
                .tabItem { Label("Deadlines", systemImage: "calendar") }
            LecturesView()
                .tabItem { Label("Lectures", systemImage: "mic") }
            AssignmentsView()
                .tabItem { Label("Work", systemImage: "tray.full") }
        }
    }
}

#Preview {
    RootView()
}
