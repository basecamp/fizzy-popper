---
description: "Set up a Fizzy board for dogfooding fizzy-popper with the Fizzy CLI"
---

Help me set up a test board on Fizzy to dogfood fizzy-popper. Walk me through it step by step using the Fizzy CLI (`fizzy`).

Here's what we need:

1. **Create a board** (or pick an existing one). Use `fizzy board list` to show what's available, then `fizzy board create --title "Agent Playground"` if we need a new one.

2. **Create columns**. We need at least two — one for the agent to watch and one for cards to land in after processing. For example:
   - `fizzy column create --board BOARD_ID --title "Triage"`
   - `fizzy column create --board BOARD_ID --title "Done"`

3. **Create a golden ticket** — this is the card that tells fizzy-popper what to do in a column. It needs:
   - A title like "Triage Agent"
   - A description with the agent's instructions (the prompt)
   - Tags: `#agent-instructions` (required), a backend tag like `#claude`, and a completion tag like `#move-to-done`
   - Placed in the column it configures
   - Optionally, steps (checklist items) the agent should follow

   ```bash
   fizzy card create --board BOARD_ID --title "Triage Agent" \
     --description "Summarize the card and propose a plan of action."
   fizzy card tag CARD_NUMBER --tag agent-instructions
   fizzy card tag CARD_NUMBER --tag claude
   fizzy card tag CARD_NUMBER --tag move-to-done
   fizzy card column CARD_NUMBER --column COLUMN_ID
   fizzy step create CARD_NUMBER --content "Acknowledge the request"
   fizzy step create CARD_NUMBER --content "Identify key requirements"
   fizzy step create CARD_NUMBER --content "Propose next steps"
   ```

4. **Create a test work card** and move it into the agent column:
   ```bash
   fizzy card create --board BOARD_ID --title "Add user authentication" \
     --description "We need OAuth2 login with Google and GitHub providers."
   fizzy card column CARD_NUMBER --column COLUMN_ID
   ```

5. **Update `.fizzy-popper/config.yml`** with the board ID and Fizzy credentials (the setup wizard handles this too: `npx tsx src/cli.ts setup`).

6. **Run fizzy-popper** and watch the agent pick up the card:
   ```bash
   npx tsx src/cli.ts start
   ```

Ask me for my Fizzy API token if you need it, and run the fizzy CLI commands to set everything up. Use `fizzy skill ask` if you need to look anything up about the Fizzy API or CLI.
