{
	// The app is not currently linked to the encore.dev platform.
	// Use "encore app link" to link it.
	"id":   "",
	"lang": "typescript",

	// Which browser origins may read an API response.
	//
	// Encore's default for non-credentialed requests is "*", so any web page
	// could fetch anything the API answers without credentials. That is a
	// small surface now — the anonymous photo endpoints were closed — but it
	// still covers the share-link endpoints and everything a `?share=` token
	// reaches.
	//
	// Only the two deployment origins are listed, because nothing else needs
	// it. The SPA is served from the same origin as the API (API_BASE_URL is
	// the empty string in a production build, i.e. relative), local
	// development goes through Vite's /api proxy, and the iOS client is not a
	// browser, so CORS never applies to it. Same-origin requests are
	// unaffected by this list.
	//
	// allow_origins_with_credentials is deliberately not set: Encore's
	// default already refuses credentialed cross-origin requests, and
	// nothing here needs them.
	"global_cors": {
		"allow_origins_without_credentials": [
			"https://app.f4mil.de",
			"https://test.f4mil.de"
		]
	}
}
