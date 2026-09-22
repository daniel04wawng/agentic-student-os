import AuthenticationServices
import SwiftUI

/// Sign-in gate. Sign in with Apple is the primary path; an emailed 6-digit code
/// is the fallback. On success AuthStore holds the session and the app shows the
/// tabs.
struct LoginView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var currentNonce = ""
    @State private var email = ""
    @State private var code = ""
    @State private var codeSent = false

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
            .padding(.horizontal)

            emailFallback

            if let msg = auth.errorMessage {
                Text(msg).font(.caption).foregroundStyle(.red).multilineTextAlignment(.center).padding(.horizontal)
            }
            if auth.working { ProgressView() }
            Spacer()
        }
        .padding()
    }

    private var emailFallback: some View {
        VStack(spacing: 10) {
            Text("or use email").font(.caption).foregroundStyle(.secondary)
            if !codeSent {
                TextField("you@email.com", text: $email)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Email me a code") { Task { codeSent = await auth.sendEmailCode(email) } }
                    .disabled(email.isEmpty || auth.working)
            } else {
                TextField("6-digit code", text: $code)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.numberPad)
                Button("Verify") { Task { await auth.verifyEmailCode(email: email, code: code) } }
                    .disabled(code.isEmpty || auth.working)
                Button("Use a different email") { codeSent = false; code = "" }.font(.caption)
            }
        }
        .padding(.horizontal)
    }
}
