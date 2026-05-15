{
  description = "kobu firmware, hardware & web config app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # Node 26 hasn't propagated from staging-next into nixos-unstable yet
    # (as of 2026-05-16). Pull `nodejs_26` from staging-next directly while
    # keeping the rest of the toolchain on the stable channel. Re-evaluate
    # when nixos-unstable catches up — at that point this input can be
    # removed and `nodejs` below should switch to `pkgs.nodejs_26`.
    nixpkgs-node.url = "github:NixOS/nixpkgs/staging-next";

    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-node, flake-utils, fenix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ fenix.overlays.default ];
        };
        pkgsNode = import nixpkgs-node { inherit system; };

        rustToolchain = pkgs.fenix.combine [
          (pkgs.fenix.stable.withComponents [
            "cargo"
            "clippy"
            "rust-src"
            "rustc"
            "rustfmt"
            "llvm-tools"
          ])
          pkgs.fenix.targets.thumbv7em-none-eabihf.stable.rust-std
        ];

        # Single source of truth for the web app's toolchain. Bump the
        # Node major here and both `nix develop` (local dev) and the
        # `Web` CI workflow follow automatically — they cannot drift.
        # See comment on the `nixpkgs-node` input above for why this
        # currently routes through staging-next.
        nodejs = pkgsNode.nodejs_26;

        firmwarePackages = [
          rustToolchain
          pkgs.flip-link
          pkgs.probe-rs-tools
          pkgs.cargo-binutils
          pkgs.cargo-generate
          pkgs.pkg-config
          pkgs.libusb1
          # Required by bindgen (used by nrf-mpsl-sys through rmk).
          pkgs.llvmPackages.libclang
          pkgs.clang
          # Render keymap SVG from firmware/keymap/*.yaml.
          pkgs.python3Packages.keymap-drawer
        ] ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
          pkgs.systemd
        ];

        webPackages = [
          nodejs
          pkgs.pnpm
        ];

        firmwareEnv = {
          # Tell bindgen which libclang to load. Without this it falls
          # back to the host system libclang which on GitHub runners
          # lacks a compatible libstdc++.
          LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
        };
      in
      {
        devShells = {
          # Full kit — both firmware and web. The default shell for
          # local dev when you might switch between firmware/ and web/
          # in the same session.
          default = pkgs.mkShell {
            packages = firmwarePackages ++ webPackages;
            env = firmwareEnv;
            shellHook = ''
              echo "kobu devshell ready (firmware + web)"
              echo "  rustc: $(rustc --version)"
              echo "  node:  $(node --version)"
              echo "  pnpm:  $(pnpm --version)"
              if ! command -v rmkit >/dev/null 2>&1; then
                echo "  note: 'rmkit' is not installed in this shell."
                echo "  install with: cargo install --locked rmkit"
              fi
              if ! command -v uf2conv >/dev/null 2>&1; then
                echo "  note: 'uf2conv' is not installed in this shell."
                echo "  install with: cargo install --locked uf2conv"
              fi
            '';
          };

          # Firmware-only. Used by `.github/workflows/firmware.yml` so
          # the CI runner does not also have to materialise Node /
          # pnpm just to build the embedded binary.
          firmware = pkgs.mkShell {
            packages = firmwarePackages;
            env = firmwareEnv;
            shellHook = ''
              echo "kobu firmware devshell"
              echo "  rustc: $(rustc --version)"
            '';
          };

          # Web-only. Used by `.github/workflows/web.yml` so the
          # cold-cache time on the runner is just Node + pnpm and not
          # the entire Rust toolchain + probe-rs + clang.
          web = pkgs.mkShell {
            packages = webPackages;
            shellHook = ''
              echo "kobu web devshell"
              echo "  node:  $(node --version)"
              echo "  pnpm:  $(pnpm --version)"
            '';
          };
        };
      });
}
