@echo off
REM  ------------ configuration -------------
set "CSV=NASDAQ.csv"       REM  change / add more CSVs if you like
set "CHECK=updateCSV.js"   REM  the string we look for in the Node command line
set "DELAY=30"             REM  seconds between checks
REM  ----------------------------------------

echo [watcher] Waiting for %CHECK% to finish …

:LOOP
rem /v   = show full command line
rem find “%CHECK%” in any node.exe line; suppress output
tasklist /fi "imagename eq node.exe" /v | findstr /i "%CHECK%" >nul
if %errorlevel%==0 (
    rem still running
    timeout /t %DELAY% >nul
    goto LOOP
)

echo [watcher] %CHECK% finished – starting training on %CSV%
node trainGRU.js %CSV%

echo [watcher] Training complete.
