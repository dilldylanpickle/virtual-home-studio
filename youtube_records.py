"""Fetch a YouTube video's audio with yt-dlp for the local server only.

The browser still decodes and plays the audio; this only downloads the original
audio stream (no transcoding, so no ffmpeg) into a temporary directory. GitHub Pages
has no server, so the page offers YouTube links only where this endpoint answers.
"""
import shutil
import tempfile
import threading
from pathlib import Path
from urllib.parse import quote, urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

try:
    import yt_dlp
except ImportError:  # The rest of the studio works without it.
    yt_dlp = None

MAX_SECONDS = 20 * 60  # The browser decodes the whole record into memory.
MAX_BYTES = 120 * 1024 * 1024
HOSTS = {'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com'}
LOCAL = {'127.0.0.1', 'localhost', '::1'}
# Audio-only streams every browser decodes natively, original-loudness (not DRC) first.
FORMAT = '/'.join(['bestaudio[ext=m4a][format_id!*=drc]', 'bestaudio[ext=webm][format_id!*=drc]',
                   'bestaudio[ext=m4a]', 'bestaudio[ext=webm]'])
TYPES = {'m4a': 'audio/mp4', 'webm': 'audio/webm'}
# Abandoned downloads finish in the background; never let them crowd out the page's own files.
SLOTS = threading.BoundedSemaphore(3)

router = APIRouter(prefix='/api/youtube')


class Link(BaseModel):
    url: str


class Unavailable(Exception):
    """A message for the listener; yt-dlp's own errors are too technical to show."""


def youtube_url(text):
    """Return the link if it names a YouTube host, else None."""
    text = text.strip()
    if len(text) > 2048: return None
    if '://' not in text: text = 'https://' + text
    try: parts = urlsplit(text)
    except ValueError: return None
    return text if parts.scheme in ('http', 'https') and (parts.hostname or '').lower() in HOSTS else None


def local_request(request):
    """Only the studio page itself may ask, never another site in the same browser."""
    host = urlsplit(f'//{request.headers.get("host", "")}').hostname
    origin = request.headers.get('origin')
    return host in LOCAL and (origin is None or (urlsplit(origin).hostname in LOCAL and urlsplit(origin).netloc == request.headers.get('host')))


def download(url, folder):
    """Download one video's audio into folder; return (path, title, ext, video id, seconds)."""
    options = {'format': FORMAT, 'noplaylist': True, 'quiet': True, 'no_warnings': True, 'noprogress': True,
               'outtmpl': str(Path(folder) / 'record.%(ext)s'), 'max_filesize': MAX_BYTES, 'socket_timeout': 20, 'retries': 2}
    with yt_dlp.YoutubeDL(options) as ydl:
        # Unprocessed first: a playlist, channel or search is refused before yt-dlp pages through it.
        info = ydl.extract_info(url, download=False, process=False)
        if info.get('_type') in ('url', 'url_transparent') and info.get('ie_key') == 'Youtube':
            info = ydl.extract_info(info['url'], download=False, process=False)  # watch?v=…&list=…
        if info.get('_type', 'video') != 'video' or info.get('extractor_key') != 'Youtube':
            raise Unavailable('Paste a link to a single YouTube video, not a playlist or channel.')
        if info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming', 'post_live'):
            raise Unavailable('Live streams can’t be played as a record.')
        if (info.get('duration') or 0) > MAX_SECONDS:
            raise Unavailable(f'That video is longer than {MAX_SECONDS // 60} minutes.')
        info = ydl.process_ie_result(info, download=True)
    files = info.get('requested_downloads') or []
    path = Path(files[0]['filepath']) if files else None
    if not path or not path.is_file():  # yt-dlp skips files over max_filesize
        raise Unavailable('That video’s audio is too large to load.')
    return (path, (info.get('title') or 'YouTube record').strip(), path.suffix.lstrip('.').lower(),
            str(info.get('id') or ''), int(info.get('duration') or 0))


def reason(error):
    """Translate yt-dlp's technical errors into a short message for the listener."""
    message = str(error).lower()
    if 'not a bot' in message:
        return 'YouTube wants to confirm this isn’t a bot. Try again later.'
    if any(word in message for word in ('private video', 'sign in', 'age-restricted', 'confirm your age', 'unavailable', 'removed', 'copyright', 'members')):
        return 'That video is private, age-restricted or unavailable.'
    if any(word in message for word in ('timed out', 'resolve', 'connection', 'network', 'unreachable')):
        return 'YouTube couldn’t be reached. Check your connection and try again.'
    return 'YouTube refused this download. Updating yt-dlp (uv lock --upgrade-package yt-dlp, then uv sync) usually fixes this.'


@router.get('')
def status(request: Request):
    return {'available': yt_dlp is not None and local_request(request)}


@router.post('')
def fetch(link: Link, request: Request):
    """Plain `def` so FastAPI runs the blocking download in its worker threads."""
    if not local_request(request): raise HTTPException(403, 'YouTube links work only from the local studio page.')
    if yt_dlp is None: raise HTTPException(503, 'YouTube support isn’t installed. Run uv sync, then restart the studio.')
    url = youtube_url(link.url)
    if not url: raise HTTPException(422, 'That doesn’t look like a YouTube link.')
    if not SLOTS.acquire(blocking=False):
        raise HTTPException(429, 'The studio is still finishing earlier downloads. Try again in a moment.')
    folder = tempfile.mkdtemp(prefix='vhs-youtube-')
    try:
        path, title, ext, video, seconds = download(url, folder)
        if ext not in TYPES: raise Unavailable('YouTube offered no audio format the browser can play.')
        # The temporary copy is removed once the response has been sent.
        return FileResponse(path, media_type=TYPES[ext], background=BackgroundTask(shutil.rmtree, folder, ignore_errors=True),
                            headers={'X-Record-Title': quote(title.encode('utf-8', 'replace'), safe=''), 'X-Record-Id': quote(video, safe=''),
                                     'X-Record-Duration': str(seconds), 'Cache-Control': 'no-store'})
    except Exception as error:
        shutil.rmtree(folder, ignore_errors=True)
        if isinstance(error, Unavailable): raise HTTPException(422, str(error)) from None
        raise HTTPException(502, reason(error)) from None
    finally:
        SLOTS.release()
