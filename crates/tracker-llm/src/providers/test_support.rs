//! A tiny HTTP/1.1 server on 127.0.0.1:0 for provider tests. It answers every
//! request with one canned response and records what it received.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone, Default)]
pub(crate) struct RecordedRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl RecordedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body).expect("request body is JSON")
    }

    pub fn query_param(&self, name: &str) -> Option<String> {
        url::form_urlencoded::parse(self.query.as_bytes()).find(|(key, _)| key == name).map(|(_, value)| value.into())
    }
}

pub(crate) struct MockServer {
    pub url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

impl MockServer {
    pub fn start(status: u16, body: &str) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let url = format!("http://{}", listener.local_addr().expect("local addr"));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        let body = body.to_string();
        // The accept loop lives for the rest of the test process; each test
        // gets its own port, so leaking it is harmless.
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                handle(stream, status, &body, &recorded);
            }
        });
        MockServer { url, requests }
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }

    pub fn only_request(&self) -> RecordedRequest {
        let requests = self.requests();
        assert_eq!(requests.len(), 1, "requests = {requests:?}");
        requests.into_iter().next().unwrap()
    }
}

fn handle(stream: TcpStream, status: u16, body: &str, recorded: &Mutex<Vec<RecordedRequest>>) -> Option<()> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));

    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let header = |name: &str| headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, v)| v.clone());
    let mut request_body = Vec::new();
    if let Some(length) = header("content-length").and_then(|value| value.parse::<usize>().ok()) {
        request_body.resize(length, 0);
        reader.read_exact(&mut request_body).ok()?;
    } else if header("transfer-encoding").is_some_and(|value| value.eq_ignore_ascii_case("chunked")) {
        loop {
            let mut size_line = String::new();
            reader.read_line(&mut size_line).ok()?;
            let size = usize::from_str_radix(size_line.trim(), 16).ok()?;
            let mut chunk = vec![0; size + 2];
            reader.read_exact(&mut chunk).ok()?;
            if size == 0 {
                break;
            }
            request_body.extend_from_slice(&chunk[..size]);
        }
    }

    // Record before responding so the test sees the request once the client
    // has its response.
    let request =
        RecordedRequest { method, path: path.to_string(), query: query.to_string(), headers, body: request_body };
    recorded.lock().unwrap().push(request);
    let mut stream = stream;
    let response = format!(
        "HTTP/1.1 {status} Status\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes()).ok()
}
