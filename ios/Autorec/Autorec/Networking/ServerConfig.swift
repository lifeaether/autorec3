import Foundation
import Observation

@Observable
final class ServerConfig {
    static let shared = ServerConfig()

    /// 初回起動時に設定画面の入力欄に出る既定値。実機を別ネットワークに移すまで
    /// この値が空のまま起動することはまずないので URL もこのまま機能する。
    static let defaultBaseURL = "http://rec3:8080"

    private let defaultsKey = "autorec.serverBaseURL"

    var baseURLString: String {
        didSet {
            UserDefaults.standard.set(baseURLString, forKey: defaultsKey)
        }
    }

    private init() {
        self.baseURLString = UserDefaults.standard.string(forKey: defaultsKey)
            ?? Self.defaultBaseURL
    }

    var baseURL: URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed)
    }

    var isConfigured: Bool { baseURL != nil }
}
