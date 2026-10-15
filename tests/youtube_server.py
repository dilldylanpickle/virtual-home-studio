"""Local server YouTube endpoint: request guards offline; a real download with VHS_TEST_YOUTUBE=1.

Run with the server on http://127.0.0.1:42069. The live part contacts YouTube and needs
the network, so it is opt-in.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from youtube_records import youtube_url  # noqa: E402

BASE = 'http://127.0.0.1:42069/api/youtube'
VIDEO = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'  # 19 seconds
checks = []


def check(ok, message):
    assert ok, message
    checks.append(message)
    print('PASS ' + message, flush=True)


def post(url, headers=None, content_type='application/json'):
    body = json.dumps({'url': url}).encode()
    request = urllib.request.Request(BASE, data=body, method='POST', headers={'Content-Type': content_type, **(headers or {})})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def detail(body):
    return json.loads(body).get('detail', '')


def run():
    with urllib.request.urlopen(BASE, timeout=10) as response:
        check(json.load(response) == {'available': True}, 'The local server reports YouTube links as available')
    request = urllib.request.Request(BASE, headers={'Host': 'evil.example'})
    with urllib.request.urlopen(request, timeout=10) as response:
        check(json.load(response) == {'available': False}, 'The status probe agrees with the guard for foreign host names')
    for text in ['https://www.youtube.com/watch?v=x', 'youtu.be/x', 'music.youtube.com/watch?v=x', 'm.youtube.com/shorts/x', 'HTTPS://WWW.YOUTUBE.COM/watch?v=x']:
        check(youtube_url(text), f'Accepts {text}')
    for text in ['https://vimeo.com/1', 'https://youtube.com.evil.example/watch', 'https://evil.example/?u=youtube.com', 'ftp://youtube.com/x', 'file:///etc/passwd', 'javascript:alert(1)', '']:
        check(not youtube_url(text), f'Rejects {text!r}')
    status, _, body = post(VIDEO, {'Origin': 'https://evil.example'})
    check(status == 403 and 'local studio' in detail(body), 'Another site in the browser cannot trigger a download (Origin)')
    status, _, body = post(VIDEO, {'Host': 'evil.example:42069'})
    check(status == 403, 'A rebound host name cannot trigger a download (Host)')
    status, _, body = post(VIDEO, {'Origin': 'http://127.0.0.1:9999'})
    check(status == 403, 'A different local port cannot trigger a download')
    status, _, _ = post(VIDEO, {'Origin': 'https://evil.example'}, content_type='text/plain')
    check(status in (403, 422), 'A simple cross-site form post cannot trigger a download')
    status, _, body = post('https://vimeo.com/1', {'Origin': 'http://127.0.0.1:42069'})
    check(status == 422 and 'YouTube link' in detail(body), 'A non-YouTube link is refused before yt-dlp runs')

    if os.environ.get('VHS_TEST_YOUTUBE') != '1':
        print('Skipping live YouTube downloads (set VHS_TEST_YOUTUBE=1 to run them).', flush=True)
    else:
        status, headers, body = post(VIDEO, {'Origin': 'http://127.0.0.1:42069'})
        headers = {key.lower(): value for key, value in headers.items()}
        check(status == 200 and headers['content-type'] in ('audio/mp4', 'audio/webm') and len(body) > 100_000, 'A short video downloads as browser-decodable audio')
        check(headers.get('x-record-title') == 'Me%20at%20the%20zoo', 'The response names the record after the video title')
        status, _, body = post('https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', {'Origin': 'http://127.0.0.1:42069'})
        check(status == 422 and 'playlist' in detail(body), 'A playlist link is refused without downloading it')
        for link in ['https://www.youtube.com/results?search_query=music', 'https://www.youtube.com/@YouTube/videos']:
            started = time.monotonic(); status, _, body = post(link, {'Origin': 'http://127.0.0.1:42069'})
            check(status == 422 and 'playlist' in detail(body) and time.monotonic() - started < 10, f'{link} is refused quickly, without paging through it')
        status, headers, _ = post(VIDEO + '&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI', {'Origin': 'http://127.0.0.1:42069'})
        check(status == 200, 'A video link inside a playlist plays that one video')
        status, _, body = post('https://www.youtube.com/watch?v=aaaaaaaaaaa', {'Origin': 'http://127.0.0.1:42069'})
        check(status in (422, 502) and 'unavailable' in detail(body), 'A missing video reports a plain reason')
    print(f'All {len(checks)} YouTube server checks passed.', flush=True)


if __name__ == '__main__':
    run()
