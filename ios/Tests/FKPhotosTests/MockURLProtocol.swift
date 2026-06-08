import Foundation

/// A `URLProtocol` that intercepts requests made through a session configured
/// with it, captures the outgoing request (and its body), and returns a canned
/// response. Used by `UploadContractTests` to assert exactly what
/// `APIClient.uploadPhoto` sends on the wire and how it handles each status
/// code — without any real network or server.
final class MockURLProtocol: URLProtocol {
    struct Stub {
        let status: Int
        let headers: [String: String]
        let body: Data
        init(status: Int, headers: [String: String] = ["Content-Type": "application/json"], body: Data) {
            self.status = status
            self.headers = headers
            self.body = body
        }
    }

    // Single-threaded test usage; reset between tests. `nonisolated(unsafe)`
    // documents that we accept the unchecked access for test scaffolding.
    nonisolated(unsafe) static var stub: Stub?
    nonisolated(unsafe) static var capturedRequest: URLRequest?
    nonisolated(unsafe) static var capturedBody: Data?

    static func reset() {
        stub = nil
        capturedRequest = nil
        capturedBody = nil
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        MockURLProtocol.capturedRequest = request
        // URLSession moves a request's `httpBody` into `httpBodyStream` by the
        // time the protocol sees it, so read whichever is present.
        if let stream = request.httpBodyStream {
            MockURLProtocol.capturedBody = MockURLProtocol.drain(stream)
        } else {
            MockURLProtocol.capturedBody = request.httpBody
        }

        let stub = MockURLProtocol.stub ?? Stub(status: 200, body: Data())
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "https://test.invalid")!,
            statusCode: stub.status,
            httpVersion: "HTTP/1.1",
            headerFields: stub.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: stub.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func drain(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let size = 4096
        var buffer = [UInt8](repeating: 0, count: size)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: size)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
