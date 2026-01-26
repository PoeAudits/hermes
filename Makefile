# Hermes System Makefile
# Provides convenient shortcuts for common operations

.PHONY: help build test typecheck clean
.PHONY: gateway node cli
.PHONY: nodes status run pair unpair pending

# -----------------------------------------------------------------------------
# Help
# -----------------------------------------------------------------------------

help:
	@echo "Hermes System - Makefile Commands"
	@echo ""
	@echo "Build & Test:"
	@echo "  make build          Build all components"
	@echo "  make test           Run all tests"
	@echo "  make typecheck      Run TypeScript type checking"
	@echo "  make clean          Clean build artifacts"
	@echo ""
	@echo "Run Services:"
	@echo "  make gateway        Start Gateway server"
	@echo "  make node           Start Node daemon"
	@echo ""
	@echo "CLI Commands:"
	@echo "  make cli            Run CLI (interactive)"
	@echo "  make nodes          List connected nodes"
	@echo "  make status         Show Gateway status"
	@echo "  make run NODE=<id> CMD=\"<command>\"  Execute command on node"
	@echo "  make pair DEVICE=<id>                Approve pending device"
	@echo "  make unpair DEVICE=<id>              Revoke device access"
	@echo "  make pending                         List pending devices"
	@echo ""
	@echo "Examples:"
	@echo "  make nodes"
	@echo "  make run NODE=abc123 CMD=\"ls -la\""
	@echo "  make pair DEVICE=abc123"

# -----------------------------------------------------------------------------
# Build & Test
# -----------------------------------------------------------------------------

build:
	bun run build

test:
	bun test

typecheck:
	bun run typecheck

clean:
	rm -rf dist/

# -----------------------------------------------------------------------------
# Run Services
# -----------------------------------------------------------------------------

gateway:
	bun run start:gateway

node:
	bun run start:node

# -----------------------------------------------------------------------------
# CLI Commands
# -----------------------------------------------------------------------------

cli:
	bun run cli

nodes:
	bun run cli nodes

status:
	bun run cli status

# Run command on node
# Usage: make run NODE=abc123 CMD="ls -la"
run:
ifndef NODE
	@echo "Error: NODE variable required"
	@echo "Usage: make run NODE=<nodeId> CMD=\"<command>\""
	@exit 1
endif
ifndef CMD
	@echo "Error: CMD variable required"
	@echo "Usage: make run NODE=<nodeId> CMD=\"<command>\""
	@exit 1
endif
	bun run cli run $(NODE) $(CMD)

# Approve pending device
# Usage: make pair DEVICE=abc123
pair:
ifndef DEVICE
	@echo "Error: DEVICE variable required"
	@echo "Usage: make pair DEVICE=<deviceId>"
	@exit 1
endif
	bun run cli pair $(DEVICE)

# Revoke device access
# Usage: make unpair DEVICE=abc123
unpair:
ifndef DEVICE
	@echo "Error: DEVICE variable required"
	@echo "Usage: make unpair DEVICE=<deviceId>"
	@exit 1
endif
	bun run cli unpair $(DEVICE)

# List pending devices
pending:
	bun run cli pending
