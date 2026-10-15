"""Explicit camera entry and optional hardware-accelerated browser launch."""
import os


def enter_turntable(page, show_controls=True):
    """Travel through the real entrance; keep normal motion and settled mapping.

    Call after initial page/model loading. This intentionally does not auto-enter
    from coordinate helpers or alter reduced-motion preferences: those shortcuts
    can conceal camera/focus regressions and test a different UI from visitors.
    Close-up opens with the listening panel hidden; by default this then presses the
    visible Show controls button, as a visitor would, so suites can reach the HUD.
    """
    page.wait_for_function('window.turntable && document.querySelector("#studio")')
    page.wait_for_function('document.querySelector("#studio").dataset.moving !== "true"')
    if page.locator('#studio').get_attribute('data-view') != 'turntable':
        page.locator('#studio-enter').click()
    page.wait_for_function('''() => {
      const studio = document.querySelector('#studio');
      return studio.dataset.view === 'turntable' && studio.dataset.moving !== 'true';
    }''', timeout=7000)
    if show_controls and page.locator('#hud-show').is_visible():
        page.locator('#hud-show').click()
        page.wait_for_function("!document.querySelector('#listening-hud').inert")
        page.wait_for_timeout(260)  # Let the 220 ms panel slide settle before measuring.


def _tuck_away(page):
    """Minimize a GPU test window. Under WSLg this parks it far off-screen while the
    page stays 'visible', so rAF, WebGL and screenshots keep running at full rate."""
    try:
        cdp = page.context.new_cdp_session(page)
        window = cdp.send('Browser.getWindowForTarget')['windowId']
        cdp.send('Browser.setWindowBounds', {'windowId': window, 'bounds': {'windowState': 'minimized'}})
        cdp.detach()
    except Exception:
        pass  # A visible window is only a nuisance, never a test failure.


def launch_browser(playwright):
    """Opt into the local WSL/NVIDIA path; ordinary test runs remain headless.

    Chromium's headless modes fall back to SwiftShader/llvmpipe in this environment,
    so the opt-in needs a real window: the installed Chromium channel with ANGLE's
    OpenGL backend on Mesa D3D12. WSLg ignores window positions, so each window is
    minimized instead, with occlusion/background throttling disabled so it keeps
    rendering. Set VHS_TEST_SHOW=1 to watch the windows. No application quality
    setting is altered.
    """
    if os.environ.get('VHS_TEST_GPU') != '1':
        return playwright.chromium.launch()
    browser = playwright.chromium.launch(
        channel='chromium', headless=False,
        args=['--use-gl=angle', '--use-angle=gl', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio',
              '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
              '--disable-background-timer-throttling'],
        env={**os.environ, 'GALLIUM_DRIVER':'d3d12', 'MESA_D3D12_DEFAULT_ADAPTER_NAME':'NVIDIA'},
    )
    if os.environ.get('VHS_TEST_SHOW') == '1':
        return browser
    # Tests open pages through new_page or new_context; hide every window they create.
    new_context = browser.new_context

    def hidden_context(*args, **kwargs):
        context = new_context(*args, **kwargs)
        context.on('page', _tuck_away)
        return context

    def hidden_page(*args, **kwargs):
        context = hidden_context(*args, **kwargs)
        return context.new_page()

    browser.new_context = hidden_context
    browser.new_page = hidden_page
    return browser
