#!/bin/bash
set -e

cd /Users/CEF/Projects/automaton

# Install root dependencies
npm install

# Install dashboard dependencies
cd dashboard && npm install && cd ..

# Install worker dependencies
cd worker && npm install && cd ..

# Install supervisor dependencies
cd supervisor && npm install && cd ..

echo "All dependencies installed."
