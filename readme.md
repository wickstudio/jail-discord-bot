# Jail Discord Bot

## Introduction
This Discord bot, developed by Wick Studio, offers an innovative solution for managing user conduct within Discord servers. It introduces a jail system where administrators can temporarily restrict users' access to server channels based on specified reasons and durations. 

## Features
- **Jail System** : Temporarily move users to a restricted role (jail) with limited permissions.
- **Customizable Jail Duration** : Set the duration for how long a user should remain in jail.
- **Reason Specification** : Specify a reason for jailing, which is logged and can be reviewed.
- **Automated Unjailing** : Automatically restore user's original roles and permissions after the jail term expires.
- **Jail Logs** : View detailed logs of all jail actions, including who was jailed/unjailed, by whom, and for what reason.

## Setup Instructions
1. **Clone the Repository**
   ```bash
   git clone https://github.com/wickstudio/jail-discord-bot.git
   cd jail-discord-bot
   ```
2. **Install Dependencies**
   ```bash
   npm install
   ```
3. **Configuration**
   - Create a `config.js` file.
   - Fill in your bot's token and other relevant configuration options in `config.js`.
4. **Run the Bot**
   ```bash
   node index.js
   ```

## Usage
After setting up the bot and inviting it to your server, the following commands are available:
- `/jail` : Jails a user with a specific reason and duration.
- `/unjail` : Unjails a user, restoring their previous roles.
- `/log` : Displays jail logs for a specified user.

## Contributing
We welcome contributions from the community! If you'd like to contribute to the Wick Studio Discord Bot, please follow these steps:
1. Fork the repository.
2. Create a new branch (`git checkout -b feature-name`).
3. Make your changes and commit them (`git commit -am 'Add some feature'`).
4. Push to the branch (`git push origin feature-name`).
5. Open a Pull Request.

## Support
Join us at our Discord server for support and community discussions : [discord.gg/wicks](https://discord.gg/wicks).

## License
This project is licensed under [MIT License](LICENSE). See the LICENSE file for more details.

## Acknowledgements
- Code by Wick Studio
- Discord.js Library

## Contact

- Email : info@wickdev.xyz

- Website : https://wickdev.xyz

- Discord : https://discord.gg/wicks

- Youtube : https://www.youtube.com/@wick_studio