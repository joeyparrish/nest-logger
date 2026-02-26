#!/bin/bash
# nest-logger — start.sh — server startup wrapper script.
# Copyright (C) 2026 Joey Parrish
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <https://www.gnu.org/licenses/>.

if [ -d "$HOME/.nvm" ]; then
  echo "Using NVM for node LTS."

  # Import NVM to get the best node version without hard-coding one.
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"

  # Set LTS node.
  nvm use --lts
fi

# Change to this folder.
cd "$(dirname "$0")"

# Install node modules again, so the native ones match the running node version.
npm ci

# Start the server.
exec node server.js
