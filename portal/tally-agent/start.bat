@echo off
echo AiFinanceo Tally Agent
echo ----------------------
if not exist "config.json" (
  echo ERROR: config.json not found.
  echo Copy config.example.json to config.json and fill in your AGENT_TOKEN.
  pause
  exit /b 1
)
node agent.js
pause
