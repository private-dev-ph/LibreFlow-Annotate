@echo off
REM LibreFlow Annotate – Start ONLY the Python inference server (standalone)
REM To start BOTH servers together, use: start_app.bat
REM
REM Run this from the project root.

cd /d "%~dp0py_scripts" 2>nul
if errorlevel 1 (
    echo [ERR] Could not find the py_scripts folder.
    pause & exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
    echo [ERR] Python .venv not found. Run: py -3.10 -m venv .venv ^&^& .venv\Scripts\python -m pip install -r requirements.txt
    pause & exit /b 1
)
echo Starting LibreFlow inference server on http://127.0.0.1:7878 ...
".venv\Scripts\python.exe" -m uvicorn infer_server:app --host 127.0.0.1 --port 7878 --reload
