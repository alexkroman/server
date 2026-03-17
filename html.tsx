// Copyright 2025 the AAI authors. MIT license.
// deno-lint-ignore-file react-no-danger
import { escape } from "@std/html";
import { renderToString } from "preact-render-to-string";

export const FAVICON_SVG: string =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="#2196F3"/><path d="M50 25c-6 0-11 5-11 11v14c0 6 5 11 11 11s11-5 11-11V36c0-6-5-11-11-11z" fill="white"/><path d="M71 50c0 11-9 21-21 21s-21-10-21-21h-6c0 14 10 25 24 27v8h6v-8c14-2 24-13 24-27h-6z" fill="white"/></svg>`;

const COPY_SCRIPT = `function copyCmd(btn){
  const text=btn.parentElement.querySelector('code').textContent;
  navigator.clipboard.writeText(text).then(()=>{
    btn.textContent='Copied!';btn.style.color='#4ade80';btn.style.borderColor='#4ade80';
    setTimeout(()=>{btn.textContent='Copy';btn.style.color='#6b7280';btn.style.borderColor='#374151'},1500);
  });
}`;

const COPY_BUTTON_HTML =
  `<button style="position:absolute;top:50%;right:16px;transform:translateY(-50%);background:transparent;border:1px solid #374151;border-radius:4px;padding:6px 10px;font-size:14px;font-family:monospace;color:#6b7280;cursor:pointer" onclick="copyCmd(this)">Copy</button>`;

function CommandBlock({ children }: { children: string }) {
  return (
    <div
      style="position:relative;background:#161616;border:1px solid #262626;border-radius:12px;padding:20px 64px 20px 24px;font-size:18px;line-height:1.6;margin-bottom:24px"
      dangerouslySetInnerHTML={{
        __html: `<code style="font-family:monospace;white-space:pre">${
          escape(children)
        }</code>${COPY_BUTTON_HTML}`,
      }}
    />
  );
}

function LandingPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>aai</title>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body style="margin:0;padding:0;box-sizing:border-box;font-family:system-ui,-apple-system,sans-serif;background:#0a0a0a;color:#d1d5db;min-height:100vh;display:flex;align-items:center;justify-content:center">
        <div style="max-width:768px;padding:48px;width:100%">
          <h1 style="font-size:4.5rem;font-weight:bold;margin:0 0 16px 0">
            aai
          </h1>
          <p style="color:#6b7280;margin:0 0 32px 0;line-height:1.6;font-size:1.25rem">
            Build and deploy a voice agent in 10 seconds.
          </p>
          <div style="font-size:1rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">
            Install
          </div>
          <CommandBlock>
            curl -fsSL https://aai-agent.fly.dev/install | sh
          </CommandBlock>
          <div style="font-size:1rem;color:#6b7280;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:12px">
            Run
          </div>
          <CommandBlock>aai</CommandBlock>
          <p style="margin-top:32px">
            <a
              style="color:#60a5fa;text-decoration:none;font-size:1.125rem"
              href="https://github.com/alexkroman/aai"
            >
              GitHub
            </a>
          </p>
        </div>

        <script dangerouslySetInnerHTML={{ __html: COPY_SCRIPT }} />
      </body>
    </html>
  );
}

export function renderLandingPage(): string {
  return "<!DOCTYPE html>" + renderToString(<LandingPage />);
}
