# ZBK Server

ZBK Server is a Windows desktop app that runs a Minecraft Java server for a Zombies Build Kit world. Choose a world, choose the resource pack players should receive, and press Start. No command line or server configuration knowledge is needed.

It is an optional companion to the [ZBK datapacks](https://github.com/Stews-Creations/zbk_datapacks) and [resource packs](https://github.com/Stews-Creations/zbk_resourcepacks). It does not install or modify packs; it hosts a world that already contains them.

## Requirements

- Windows 10 or later.
- Java for the world's Minecraft version. Minecraft 26.2 needs Java 25. The Server section reports whether Java was found and links to a download.
- An internet connection the first time each Minecraft version is used, to download the official server from Mojang.
- A world that already contains its datapacks. A downloaded ZBK map includes them.

## Use the app

Everything is on one page. Three sections across the top set the server up, and the console and player lists below show it running. Each section shows **Ready** when it is complete, and the note beside **Start server** names whatever is still missing.

### World

Choose the world folder, the one that contains `level.dat`. Worlds are usually in `%APPDATA%\.minecraft\saves`.

The server runs the world exactly as it is, so prepare it first:

- Put the ZBK base pack and your map's datapack in the world's `datapacks` folder.
- Make sure your map's structures are in the world. They can live inside a datapack, under `data/<namespace>/structure/`, or in the world's `generated` folder when they were saved in game. The base pack carries its own structures inside its datapack.

The section shows the Minecraft version, whether the ZBK base pack was found, how many datapacks and structures the world has, and whether it has a resource pack inside it. The structure count covers both datapacks and the world; hover over it for the split. Open **Datapacks in this world** to see each datapack and the structures it carries. Datapack folders that are links to another location are read and copied as ordinary files.

### Resource pack

Players need the resource pack to see ZBK models and hear its sounds.

A world can carry a resource pack at `resourcepacks/resources.zip`. Singleplayer loads it automatically, but a server never sends files from the world folder to players. It gives each player a download link when they join. When the selected world has a pack inside it, the app selects that pack and creates the link.

| Choice | Result |
| --- | --- |
| From the world | Sends the world's own pack. Selected automatically when the world has one. |
| ZIP file | Sends a ZIP you pick. `pack.mcmeta` must be at the top level of the ZIP. |
| None | Players see default Minecraft textures and sounds. |

The section shows the link players will download from. Open **Download options** to change how it is delivered:

- **This computer.** The app serves the ZIP while the server runs. Players on your home network can join immediately.
- **Online link.** Paste a direct download link to the same ZIP, such as a GitHub release file.

### Server

Set the memory, port, and player limit. **Address players join with** is optional: enter a host name or tunnel address to share that instead of this computer's address. **More settings** holds the server list message, the Minecraft version, and the server folder. Tick the Minecraft EULA box before the first start.

### Run the server

Press **Start server**. The first start copies the world, downloads the server, and checks the download against Mojang's published checksum.

- **Console** shows server messages and accepts commands. **Expand** gives it the whole window; **Shrink** or the Escape key brings the setup sections back.
- **Players online** lists who is connected.
- **Make admin** gives a player operator rights so they can use commands in game. **Remove admin** takes them away. You can also add an admin by name.
- **Players join with** shows the address to give players: the one you entered, or this computer's address on your network.

**Stop** lets the server save before it closes. Press it again to end a server that does not respond. Setup choices are locked while the server runs.

## Where the server is kept

The server folder defaults to `Documents\ZBK Server`. Change it under **More settings** in the Server section.

The server works on its own copy of the world, so your original save is never changed and progress made on the server is kept between runs. To start over from the original, tick **Replace the server world with a fresh copy** before starting. This erases the server's copy after you confirm.

Settings made by hand in `server.properties` are kept. The app only updates the world name, port, player limit, server list message, and resource pack entries.

## Playing with friends outside your network

Players on other networks need an address that reaches this computer, and your router must forward two ports to it:

| Port | Purpose |
| --- | --- |
| 25565 (TCP) | The Minecraft server. Change it in the Server section. |
| 8123 (TCP) | The resource pack download, when shared from this computer. |

Enter that address under **Address players join with**. The same address is used for the resource pack link unless you set a different one in **Download options**. If the resource pack is already online, only the server port is needed.

### Keep your IP address private

Anyone who joins by IP address can see it. To avoid handing it out:

- **Host name.** A dynamic DNS name such as `play.example.net` is easier to share and can follow a changing IP address. It still resolves to your IP address, so it is a convenience rather than privacy.
- **Tunnel service.** A tunnel gives players an address owned by the service, and your IP address stays hidden. Enter the tunnel's address, including its port if it has one, under **Address players join with**. When the resource pack is shared from this computer it needs its own tunnel to port 8123; enter that address and port, such as `packs.example.net:41234`, under **Address for the pack download**. Hosting the pack online avoids the second tunnel.

## Development

Install [Node.js](https://nodejs.org/) 22 or later, then run from this folder:

```powershell
npm install
npm start
npm test
```

`npm test` uses a stand-in server process and local connections. It does not download or run Minecraft.

| Location | Responsibility |
| --- | --- |
| [src/main/main.js](src/main/main.js) | Window, saved configuration, and requests from the interface |
| [src/main/preload.js](src/main/preload.js) | The named requests the interface may make |
| [src/main/lib/world.js](src/main/lib/world.js) | World inspection: datapacks, structures, bundled resource pack |
| [src/main/lib/resource-pack.js](src/main/lib/resource-pack.js) | Resource pack validation, hashing, and sharing |
| [src/main/lib/session.js](src/main/lib/session.js) | Server folder preparation and the server process |
| [src/main/lib/jar.js](src/main/lib/jar.js) | Server lookup and verified download |
| [src/main/lib/log-events.js](src/main/lib/log-events.js) | Player and admin events read from console output |
| [src/main/lib/address.js](src/main/lib/address.js) | Host names, IP addresses, and ports entered by the user |
| [src/renderer](src/renderer) | Interface page, styles, and logic |
| [test](test) | Automated checks |
| [tools/check_package.js](tools/check_package.js) | Inspection of a finished build before it is published |

The interface runs sandboxed without Node.js access. Files and processes are handled in the main process, and modules under `src/main/lib` do not depend on Electron so they can be tested directly.

### Build installers

```powershell
npm run build
npm run check:package
```

The build writes `ZBK-Server-Setup-<version>.exe` and `ZBK-Server-<version>-portable.exe` to `dist/`. The check confirms that both exist, that the `LICENSES` folder sits beside the app unchanged, that the Electron and Chromium notices are present, and that the packaged app holds only application files. It prints the SHA-256 checksum of each executable.

The executables are not code signed, so Windows shows an unknown publisher warning the first time they run.

## Releases

Download installers from the [releases page](https://github.com/Stews-Creations/zbk_server/releases). Build output is not committed.

| Workflow | Runs | Result |
| --- | --- | --- |
| [Build ZBK Server](.github/workflows/build.yml) | On every push, or manually | Tests, builds, inspects the build, and uploads the installer and portable app as workflow artifacts. These are development builds. |
| [Release ZBK Server](.github/workflows/release.yml) | Manually from `main` | Publishes a GitHub release with the installer and the portable app. Their checksums are printed in the workflow log. |

To publish a release, set `version` in `package.json` and `package-lock.json`, merge to `main`, then run **Release ZBK Server** with the matching tag, such as `v1.0.0`. The workflow stops if the tag and the app version differ. Running it with an existing tag rebuilds that revision.

## License and credit

Free noncommercial use, modification, and sharing are allowed with credit to
[MiniStew](https://www.youtube.com/@MiniStew). Monetized videos and streams are
allowed under the [media permission](LICENSES/MEDIA_PERMISSION.md). Selling covered ZBK
content or maps containing it, or charging for server access, is not covered
by that permission. See [licensing and attribution](LICENSES/LICENSE.md) for the code
and asset licenses, their scope, and redistribution requirements.

Minecraft is downloaded from Mojang and remains subject to the [Minecraft EULA](https://aka.ms/MinecraftEULA). Electron and other dependencies keep their own licenses.
