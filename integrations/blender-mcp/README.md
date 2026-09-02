# Blender MCP

This integration uses the upstream MIT-licensed `MCPBlender/blender-mcp` package.

Run `powershell -ExecutionPolicy Bypass -File scripts/install-blender-mcp.ps1` to install the project-local `uvx` runtime and refresh `addon.py`.

In Blender, open `Edit > Preferences > Add-ons > Install...`, select `addon.py`, enable `Blender MCP`, then open the 3D View sidebar and start the MCP server. The addon listens on `127.0.0.1:9876` by default.

The workbench MCP entry launches the protocol server. Blender itself and the enabled addon must be running before Blender tool calls can succeed.
