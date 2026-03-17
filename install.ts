// Copyright 2025 the AAI authors. MIT license.
export const INSTALL_SCRIPT = `#!/bin/sh
set -e

REPO="alexkroman/aai"
INSTALL_DIR="\${AAI_INSTALL_DIR:-\$HOME/.aai/bin}"

# Verify curl is available
if ! command -v curl >/dev/null 2>&1; then
  echo "Error: curl is required to install aai." >&2
  exit 1
fi

# Detect OS and architecture
OS="\$(uname -s)"
ARCH="\$(uname -m)"

case "\$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *) echo "Unsupported OS: \$OS" >&2; exit 1 ;;
esac

case "\$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64)        arch="x64" ;;
  *) echo "Unsupported architecture: \$ARCH" >&2; exit 1 ;;
esac

ARTIFACT="aai-\${os}-\${arch}"
URL="https://github.com/\$REPO/releases/download/latest/\${ARTIFACT}.tar.gz"

# Install Deno if not present (required runtime)
if ! command -v deno >/dev/null 2>&1; then
  echo "Installing Deno..."
  curl -fsSL https://deno.land/install.sh | sh
  export DENO_INSTALL="\$HOME/.deno"
  export PATH="\$DENO_INSTALL/bin:\$PATH"
fi

echo "Installing aai (\$os/\$arch)..."

# Download and extract
mkdir -p "\$INSTALL_DIR"
TMP="\$(mktemp -d)"
trap 'rm -rf "\$TMP"' EXIT

if ! curl -fsSL "\$URL" | tar xz -C "\$TMP"; then
  echo "Download failed. Check that a release exists for \$os/\$arch." >&2
  exit 1
fi
mv "\$TMP/aai" "\$INSTALL_DIR/aai"
chmod +x "\$INSTALL_DIR/aai"

# Verify the binary works
if ! "\$INSTALL_DIR/aai" --version >/dev/null 2>&1; then
  echo "Warning: installed binary does not appear to work" >&2
fi

echo "Installed aai to \$INSTALL_DIR/aai"

# Add to PATH if needed (skip if already present)
case ":\$PATH:" in
  *":\$INSTALL_DIR:"*) ;;
  *)
    SHELL_NAME="\$(basename "\$SHELL")"
    case "\$SHELL_NAME" in
      zsh)  RC="\$HOME/.zshrc" ;;
      bash) RC="\$HOME/.bashrc" ;;
      fish) RC="\$HOME/.config/fish/config.fish" ;;
      *)    RC="" ;;
    esac
    if [ -n "\$RC" ]; then
      PATH_LINE="export PATH=\\"\\\$HOME/.aai/bin:\\\$PATH\\""
      if [ -f "\$RC" ] && grep -qF ".aai/bin" "\$RC"; then
        echo "\$INSTALL_DIR already in \$RC"
      else
        echo "" >> "\$RC"
        echo "\$PATH_LINE" >> "\$RC"
        echo "Added \$INSTALL_DIR to PATH in \$RC"
      fi
      echo "Run: source \$RC"
    else
      echo "Add \$INSTALL_DIR to your PATH"
    fi
    ;;
esac

echo "Run 'aai' to get started"
`;
