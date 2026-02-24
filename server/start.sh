#!/bin/bash

# Import NVM to get the best node version without hard-coding one.
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"

# Change to this folder.
cd "$(dirname "$0")"

# Start the server.
exec node server.js
