// macOS: xcrun swift internal/gui/tests/plugin-page-zoom.swift
// Playwright's WebKit does not exercise WKWebView.pageZoom. Use the real
// renderer and app.css: open a sandboxed plugin page, leave it, change the
// text size, then return. The frame must still paint right to both edges.
import Cocoa
import WebKit

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let css = try String(contentsOf: URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("assets/app.css"), encoding: .utf8)

final class Files: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        let path = task.request.url!.path
        let body: String
        let type: String
        switch path {
        case "/":
            type = "text/html"
            body = """
            <!doctype html><link rel="stylesheet" href="/app.css">
            <body class="window mac">
            <main class="view plugin-page" id="plugin">
              <iframe class="plugin-frame" sandbox="allow-scripts" src="/page"></iframe>
            </main>
            <main class="view" id="other" hidden>Another page</main>
            <script>
            addEventListener('message', e => {
              if (e.source === document.querySelector('iframe').contentWindow && e.data === 'ready')
                window.webkit.messageHandlers.ready.postMessage('ready');
            });
            </script>
            """
        case "/app.css":
            type = "text/css"
            body = css
        default:
            type = "text/html"
            body = """
            <!doctype html><style>html,body {margin:0; background:rgb(208,32,128)}</style>
            <script>addEventListener('load', () => parent.postMessage('ready', '*'));</script>
            """
        }
        task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!)
        task.didReceive(Data(body.utf8))
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Ready: NSObject, WKScriptMessageHandler {
    var run: (() -> Void)?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let start = run
        run = nil
        start?()
    }
}

let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
config.setURLSchemeHandler(Files(), forURLScheme: "wails")
let ready = Ready()
config.userContentController.add(ready, name: "ready")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 800), configuration: config)
let window = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
window.contentView = web
window.setFrameOrigin(NSPoint(x: -10000, y: -10000))
window.orderBack(nil)

func settled() async throws {
    _ = try await web.callAsyncJavaScript("""
        document.getAnimations().forEach(a => a.finish());
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        """, arguments: [:], in: nil, in: .page)
}

ready.run = {
    Task { @MainActor in
        do {
            for zoom in [1.25, 1.5, 1.1, 1.0] {
                _ = try await web.evaluateJavaScript("plugin.hidden=true; other.hidden=false")
                try await settled()
                web.pageZoom = zoom
                try await settled()
                _ = try await web.evaluateJavaScript("other.hidden=true; plugin.hidden=false")
                try await settled()
                let rect = try await web.evaluateJavaScript("""
                    (() => {const r=document.querySelector('iframe').getBoundingClientRect();
                      return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth};})()
                    """) as! [String: Double]
                let snapshot = try await web.takeSnapshot(configuration: nil)
                let pixels = NSBitmapImageRep(data: snapshot.tiffRepresentation!)!
                let scale = Double(pixels.pixelsWide) / rect["vw"]!
                func colorAt(_ x: Double, _ y: Double) -> NSColor {
                    pixels.colorAt(x: Int((rect["x"]! + x * rect["width"]!) * scale),
                        y: Int((rect["y"]! + y * rect["height"]!) * scale))!.usingColorSpace(.sRGB)!
                }
                // Compare within the snapshot: the display's colour profile
                // can change the RGB values, but never one edge alone.
                let center = colorAt(0.5, 0.5)
                guard center.redComponent > 0.6, center.greenComponent < 0.5 else {
                    print("FAIL: plugin fixture did not paint: \(center)")
                    exit(1)
                }
                for (edge, x, y) in [("right", 0.95, 0.5), ("bottom", 0.5, 0.95)] {
                    let color = colorAt(x, y)
                    guard abs(color.redComponent - center.redComponent) < 0.04,
                          abs(color.greenComponent - center.greenComponent) < 0.04,
                          abs(color.blueComponent - center.blueComponent) < 0.04 else {
                        print("FAIL: hidden plugin page leaves its \(edge) edge unpainted after zoom \(zoom): \(color)")
                        exit(1)
                    }
                }
                print("PASS: hidden plugin page paints both edges after zoom \(zoom)")
            }
            exit(0)
        } catch {
            print("FAIL: \(error)")
            exit(1)
        }
    }
}
web.load(URLRequest(url: URL(string: "wails://localhost/")!))
DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
    print("FAIL: plugin page zoom test timed out")
    exit(1)
}
app.run()
