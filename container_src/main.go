package main

import (
	"io"
	"net/http"
	"os"
)

const userAgent = "Podr/1.0 (+https://www.podrapp.com) podcast-search"

func main() {
	client := &http.Client{}

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		itunesURL := r.URL.Query().Get("url")
		if itunesURL == "" {
			http.Error(w, "Missing url parameter", http.StatusBadRequest)
			return
		}

		req, err := http.NewRequest("GET", itunesURL, nil)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		req.Header.Set("User-Agent", userAgent)
		req.Header.Set("Accept", "application/json")

		resp, err := client.Do(req)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()

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
