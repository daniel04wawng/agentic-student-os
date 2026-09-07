.PHONY: install ts-build ts-typecheck ts-lint ts-test \
        py-install py-lint py-typecheck py-test \
        ios-validate ios-typecheck check

# ---- TypeScript (root workspaces: shared + backend) ----
install:
	npm install

ts-build:
	npm run build

ts-typecheck: ts-build
	npm run typecheck

ts-lint:
	npm run lint

ts-test:
	npm test

# ---- Python inference service ----
py-install:
	cd services/inference && uv sync --extra dev

py-lint:
	cd services/inference && uv run ruff check .

py-typecheck:
	cd services/inference && uv run mypy app

py-test:
	cd services/inference && uv run pytest

# ---- iOS ----
ios-validate:
	xcodebuild -list -project ios/StudentOS.xcodeproj

# Syntax/type check the SwiftUI sources against the iOS SDK without a full build.
ios-typecheck:
	xcrun swiftc -typecheck -sdk $$(xcrun --sdk iphonesimulator --show-sdk-path) \
	  -target arm64-apple-ios17.0-simulator ios/StudentOS/*.swift

# ---- Aggregate ----
check: ts-build ts-typecheck ts-lint ts-test py-lint py-typecheck py-test ios-validate
