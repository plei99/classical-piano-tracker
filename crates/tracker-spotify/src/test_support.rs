//! A minimal HTTP/1.1 mock server for tests: one request per connection,
//! answered by a closure, with every request recorded for assertions.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Recorded {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// First value of a form-encoded body field, or "" when absent.
    pub fn form(&self, key: &str) -> String {
        form_urlencoded::parse(self.body.as_bytes())
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.into_owned())
            .unwrap_or_default()
    }
}

pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Reply {
    pub fn json(status: u16, body: &str) -> Reply {
        Reply { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.into() }
    }

    pub fn text(status: u16, body: &str) -> Reply {
        Reply { status, headers: Vec::new(), body: body.into() }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Reply {
        self.headers.retain(|(key, _)| !key.eq_ignore_ascii_case(name));
        self.headers.push((name.into(), value.into()));
        self
    }
}

type Handler = dyn Fn(&Recorded) -> Reply + Send + Sync;

pub struct MockServer {
    pub base_url: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    addr: std::net::SocketAddr,
}

impl MockServer {
    pub fn start(handler: impl Fn(&Recorded) -> Reply + Send + Sync + 'static) -> MockServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock server");
        let addr = listener.local_addr().expect("mock server address");
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let handler: Arc<Handler> = Arc::new(handler);
        {
            let requests = Arc::clone(&requests);
            let stop = Arc::clone(&stop);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let Ok(stream) = stream else { continue };
                    serve(stream, handler.as_ref(), &requests);
                }
            });
        }
        MockServer { base_url: format!("http://{addr}"), requests, stop, addr }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    pub fn single_request(&self) -> Recorded {
        let requests = self.requests();
        assert_eq!(requests.len(), 1, "requests: {requests:?}");
        requests[0].clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.addr);
    }
}

/// Records the request before replying so assertions never race the client.
fn serve(stream: TcpStream, handler: &Handler, requests: &Mutex<Vec<Recorded>>) -> Option<()> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();

    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).ok()? == 0 {
            break;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers.push((name.trim().to_string(), value.trim().to_string()));
    }
    let length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;

    let request = Recorded { method, target, headers, body: String::from_utf8_lossy(&body).into_owned() };
    let reply = handler(&request);
    requests.lock().unwrap().push(request);
    let mut response =
        format!("HTTP/1.1 {} Mock\r\nContent-Length: {}\r\nConnection: close\r\n", reply.status, reply.body.len());
    for (name, value) in &reply.headers {
        response.push_str(&format!("{name}: {value}\r\n"));
    }
    response.push_str("\r\n");
    response.push_str(&reply.body);
    let mut stream = stream;
    stream.write_all(response.as_bytes()).ok()
}

/// Issues a raw GET, the way a browser follows the OAuth redirect, and
/// returns the status line, headers, and body as one string.
pub fn raw_get(addr: std::net::SocketAddr, target: &str) -> String {
    let mut stream = TcpStream::connect(addr).expect("connect to callback server");
    write!(stream, "GET {target} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}
