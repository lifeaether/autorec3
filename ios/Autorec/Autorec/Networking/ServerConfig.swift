import Foundation
import Observation

@Observable
final class ServerConfig {
    static let shared = ServerConfig()

    private let defaultsKey = "autorec.serverBaseURL"

    var baseURLString: String {
        didSet {
            UserDefaults.standard.set(baseURLString, forKey: defaultsKey)
        }
    }

    private init() {
        self.baseURLString = UserDefaults.standard.string(forKey: defaultsKey) ?? ""
    }

    var baseURL: URL? {
        let trimmed = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return URL(string: trimmed)
    }

    var isConfigured: Bool { baseURL != nil }
}
