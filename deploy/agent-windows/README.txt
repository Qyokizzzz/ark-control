ARK Control Host Agent for Windows x64

1. Extract the complete ZIP to a permanent folder on the game host.
2. In the ARK Control web console, select your workspace and add a host.
3. Run ArkHostAgent.cmd and enter the game data folder and one-time code.
   ZIPs downloaded from the web console carry the console URL in
   ArkHostAgent.json. A standalone build asks for the URL on first enrollment.
   The console should show Online. Startup and enrollment log to state/agent.log.
4. To enable automatic startup at Windows sign-in, close the manual Agent
   and run ArkHostAgent.cmd again. Select option 3. Option 4 removes the task.
5. Keep state/config.json private. It stores the Agent credential. The ZIP
   includes the Node runtime. Store game data on a volume with enough space.
