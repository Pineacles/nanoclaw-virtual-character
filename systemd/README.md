# Multi-Instance NanoClaw with systemd

## Setup

1. Copy the template unit file:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp nanoclaw@.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   ```

2. Create an env file for your instance:
   ```bash
   cp env-template.conf env-myagent.conf
   # Edit env-myagent.conf with your settings
   ```

3. Enable and start:
   ```bash
   systemctl --user enable nanoclaw@myagent
   systemctl --user start nanoclaw@myagent
   ```

4. Check status:
   ```bash
   systemctl --user status nanoclaw@myagent
   journalctl --user -u nanoclaw@myagent -f
   ```

## Running Multiple Instances

Each instance needs unique ports:
- Instance A: WEB_PORT=3003, CREDENTIAL_PROXY_PORT=3001
- Instance B: WEB_PORT=3004, CREDENTIAL_PROXY_PORT=3002

Use the reverse proxy (`../proxy/proxy.js`) to serve both from a single domain.

## Updating

Both instances share the same codebase:
```bash
cd ~/nanoclaw
git pull && npm run build
systemctl --user restart nanoclaw@instancea nanoclaw@myagent
```
