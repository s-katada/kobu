{
  description = "kobu firmware, hardware & web config app";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, fenix }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ fenix.overlays.default ];
        };

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
        nodejs = pkgs.nodejs_22;

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
