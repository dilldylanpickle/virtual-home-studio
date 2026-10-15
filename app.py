"""Serve the simulator locally. Local files never leave the browser.

The local server also fetches YouTube audio with yt-dlp (youtube_records.py); the
static GitHub Pages site has no server, so it offers local files only.
"""
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from youtube_records import router as youtube

ROOT = Path(__file__).resolve().parent
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
app.include_router(youtube)


@app.middleware("http")
async def revalidate(request, call_next):
    # Always revalidate (unchanged files still answer 304 via ETag), so the page,
    # its stylesheets and its modules can never mix old and new versions.
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=42069)
