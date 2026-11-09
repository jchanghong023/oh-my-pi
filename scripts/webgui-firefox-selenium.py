"""Opt-in Selenium Firefox bridge. Uses installed/cached drivers; never downloads."""

import json
import os
from pathlib import Path
import shutil
import sys

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.remote.command import Command
from selenium.webdriver.remote.webelement import WebElement


def installed_driver():
    explicit = os.environ.get("GECKODRIVER_EXECUTABLE") or shutil.which("geckodriver")
    if explicit:
        return explicit
    executable = "geckodriver.exe" if os.name == "nt" else "geckodriver"
    cached = list((Path.home() / ".cache" / "selenium" / "geckodriver").glob(f"*/*/{executable}"))
    if not cached:
        raise RuntimeError("Installed geckodriver required: set GECKODRIVER_EXECUTABLE or PATH; downloads are disabled")
    return str(max(cached, key=lambda item: tuple(int(part) for part in item.parent.name.split("."))))


def encode(value):
    if isinstance(value, WebElement):
        return {"element-6066-11e4-a52e-4f735466cecf": value.id}
    if isinstance(value, list):
        return [encode(item) for item in value]
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    return value


COMMANDS = {
    "WebDriver:SetWindowRect": Command.SET_WINDOW_RECT,
    "WebDriver:GetWindowRect": Command.GET_WINDOW_RECT,
    "WebDriver:ExecuteScript": Command.W3C_EXECUTE_SCRIPT,
    "WebDriver:FindElement": Command.FIND_ELEMENT,
    "WebDriver:GetWindowHandles": Command.W3C_GET_WINDOW_HANDLES,
    "WebDriver:GetWindowHandle": Command.W3C_GET_CURRENT_WINDOW_HANDLE,
    "WebDriver:SwitchToWindow": Command.SWITCH_TO_WINDOW,
    "WebDriver:PerformActions": Command.W3C_ACTIONS,
    "WebDriver:ReleaseActions": Command.W3C_CLEAR_ACTIONS,
    "WebDriver:Navigate": Command.GET,
    "WebDriver:Refresh": Command.REFRESH,
    "WebDriver:ElementClick": Command.CLICK_ELEMENT,
    "WebDriver:ElementSendKeys": Command.SEND_KEYS_TO_ELEMENT,
    "WebDriver:CloseWindow": Command.CLOSE,
    "WebDriver:TakeScreenshot": Command.SCREENSHOT,
    "WebDriver:NewWindow": Command.NEW_WINDOW,
}


def main():
    driver = None
    try:
        for line in sys.stdin:
            request = json.loads(line)
            name = request["name"]
            parameters = request.get("parameters", {})
            try:
                if name == "WebDriver:NewSession":
                    options = Options()
                    options.binary_location = parameters["firefox"]
                    if parameters.get("headless"):
                        options.add_argument("-headless")
                    options.add_argument("-profile")
                    options.add_argument(parameters["profile"])
                    options.accept_insecure_certs = False
                    for key, value in parameters["preferences"].items():
                        options.set_preference(key, value)
                    service = Service(executable_path=installed_driver(), env=parameters.get("environment"))
                    driver = webdriver.Firefox(options=options, service=service)
                    driver.execute(Command.SET_TIMEOUTS, parameters["timeouts"])
                    result = {"sessionId": driver.session_id, "capabilities": driver.capabilities}
                elif name == "WebDriver:DeleteSession":
                    if driver is not None:
                        driver.quit()
                        driver = None
                    result = None
                else:
                    if driver is None:
                        raise RuntimeError("Selenium Firefox session is not open")
                    result = driver.execute(COMMANDS[name], parameters).get("value")
                response = {"id": request["id"], "value": encode(result)}
            except Exception as error:
                response = {"id": request["id"], "error": f"Selenium {name}: {error}"}
            print(json.dumps(response, ensure_ascii=True), flush=True)
    finally:
        if driver is not None:
            driver.quit()


if __name__ == "__main__":
    main()
