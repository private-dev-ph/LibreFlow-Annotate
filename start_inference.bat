@echo off
REM LibreFlow Annotate – Start ONLY the Python inference server (standalone)
REM To start BOTH servers together, use: start_app.bat
REM
REM Run this from the py_scripts folder or the project root

cd /d "%~dp0py_scripts" 2>nul || cd /d "%~dp0"
if not exist ".venv\Scripts\activate.bat" (
    echo [ERR] .venv not found. Run: py -3.10 -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt
    pause & exit /b 1
)
echo Starting LibreFlow inference server on http://127.0.0.1:7878 ...
call .venv\Scripts\activate.bat
uvicorn infer_server:app --host 127.0.0.1 --port 7878 --reload
