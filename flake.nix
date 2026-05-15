{
  description = "kobu firmware & hardware";

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
      in
      {
        devShells.default = pkgs.mkShell {
          packages = [
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

          env = {
            # Tell bindgen which libclang to load. Without this it falls back
            # to the host system libclang which on GitHub runners lacks a
            # compatible libstdc++.
            LIBCLANG_PATH = "${pkgs.llvmPackages.libclang.lib}/lib";
          };

          shellHook = ''
            echo "kobu devshell ready"
            echo "  rustc: $(rustc --version)"
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
      });
}
