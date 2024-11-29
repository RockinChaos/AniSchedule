# AniSchedule

**AniSchedule** is a fully automated tool that fetches and organizes schedules and episode feeds for current airing anime, including dubs, subs, and hentai. The generated files are updated regularly and published directly to this repository using GitHub Actions.

> [!TIP]
> **Fast Updates:** Stay on top of airing schedules and episode feeds without any hassle or nasty rate limits when resolving media!

## Features

- **🎬 Dub Schedules:** Fetched hourly from [AnimeSchedule.net](https://www.animeschedule.net).
- **📅 Sub Schedules:** Fetched every 6 hours from [AniList](https://anilist.co).
- **📜 Episode Feeds:** Logs for dubs, subs, and hentai episodes, continuously updated.
- **📄 Accessible Outputs:** Both raw JSON and human-readable JSON files are available for easy integration and consumption.

## Outputs

### 📝 Readable Paths
For easy viewing of the schedules and feeds:

- **[Dub Episode Feed (Readable)](https://github.com/RockinChaos/AniSchedule/blob/master/dub-episode-feed-readable.json)**
- **[Dub Schedule (Readable)](https://github.com/RockinChaos/AniSchedule/blob/master/dub-schedule-readable.json)**
- **[Hentai Episode Feed (Readable)](https://github.com/RockinChaos/AniSchedule/blob/master/hentai-episode-feed-readable.json)**
- **[Sub Episode Feed (Readable)](https://github.com/RockinChaos/AniSchedule/blob/master/sub-episode-feed-readable.json)**
- **[Sub Schedule (Readable)](https://github.com/RockinChaos/AniSchedule/blob/master/sub-schedule-readable.json)**

### 📡 Raw JSON Paths
For programmatic use and integration:

- **[Dub Episode Feed (Raw)](https://github.com/RockinChaos/AniSchedule/blob/master/dub-episode-feed.json)**
- **[Dub Schedule (Raw)](https://github.com/RockinChaos/AniSchedule/blob/master/dub-schedule.json)**
- **[Hentai Episode Feed (Raw)](https://github.com/RockinChaos/AniSchedule/blob/master/hentai-episode-feed.json)**
- **[Sub Episode Feed (Raw)](https://github.com/RockinChaos/AniSchedule/blob/master/sub-episode-feed.json)**
- **[Sub Schedule (Raw)](https://github.com/RockinChaos/AniSchedule/blob/master/sub-schedule.json)**

## Update Frequency

- **⏰ Dub Schedule:** Updated every hour.
- **⏳ Sub Schedule:** Updated every 6 hours.
- **📺 Episode Feeds:** Updated continuously as new episodes air.

## How It Works

AniSchedule uses a combination of APIs from **AnimeSchedule.net** and **AniList** to fetch scheduling data. The data is processed and sorted into episode feeds and schedules, then uploaded to this repository using GitHub Actions.

> 🔄 **Automation:** The entire update process is handled automatically, so you can focus on enjoying the latest episodes without worrying about updates!

## Contributing

Contributions, feature requests, and issue reports are welcome! Feel free to open an issue or submit a pull request. If you would like to contribute, please ensure your changes follow the format of the existing updates and maintain consistency in data structure.

## License

This project is licensed under the GPL-3.0 License. See [LICENSE](LICENSE) for details.

---

:star: **Star this repo if you find it useful!** :star:
