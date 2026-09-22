import AuthenticationServices
import SwiftUI

/// Sign-in gate. Sign in with Apple: the app gets an identity token from Apple,
/// hands it to our backend, and gets back a session. On success AuthStore holds
/// the session and the app shows the tabs.
struct LoginView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var currentNonce = ""

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 8) {
                Image(systemName: "graduationcap.fill").font(.system(size: 56)).foregroundStyle(.tint)
                Text("Student OS").font(.largeTitle.bold())
                Text("Your classes, prepped for you.").foregroundStyle(.secondary)
            }
            Spacer()

            SignInWithAppleButton(.signIn) { request in
                let nonce = randomNonce()
                currentNonce = nonce
                request.requestedScopes = [.email]
                request.nonce = sha256Hex(nonce)
            } onCompletion: { result in
                guard case .success(let authorization) = result,
                      let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
                      let tokenData = cred.identityToken,
                      let idToken = String(data: tokenData, encoding: .utf8) else { return }
                Task { await auth.signInWithApple(idToken: idToken, rawNonce: currentNonce) }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 50)
            .padding(.horizontal, 40)

            if let msg = auth.errorMessage {
                Text(msg).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center).padding(.horizontal)
            }
            if auth.working { ProgressView() }

            Text("We use your Apple sign-in only to identify your account. Connect Canvas and Google after signing in.")
                .font(.caption2).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 32)
            Spacer()
        }
        .padding()
    }
}
