package main

import (
	"io"
	"net/http"
	"os"
)

func main() {
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Extract the iTunes URL from query param
		itunesURL := r.URL.Query().Get("url")
		if itunesURL == "" {
			http.Error(w, "Missing url parameter", http.StatusBadRequest)
			return
		}

		// Fetch from iTunes
		resp, err := http.Get(itunesURL)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

		// Forward headers and body
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.ListenAndServe(":"+port, nil)
}
