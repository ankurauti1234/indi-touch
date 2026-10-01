# Indi Meter Screens and Features

This document describes the screens and user-facing behavior implemented by the web application. The interface is a single-page app: the navigation rail switches views without loading a new page, and settings open as panels within the Settings view.

## Application Startup

- **Initializing Hub** is the short loading screen shown while localization and application data are initialized.
- The app checks installation status through the onboarding status API. If installation is incomplete, the setup wizard is shown; otherwise, the main app is shown.
- Startup loads household members, guests, location/weather, and notifications, then starts the clock, screensaver, TV-state reminders, and scheduled maintenance checks.

## Onboarding Wizard

The setup wizard contains seven steps. Back and Next actions change steps without leaving the page. Wi-Fi selection and validation can skip steps depending on the current network.

### 1. Welcome

Introduces Indi Meter and provides **Start Setup**. An information button opens device information; when available, this includes the meter/device ID, IP address, and connected Wi-Fi name.

### 2. Network Setup

Scans for nearby Wi-Fi networks and displays signal/security state. The current network is moved to the top and selected automatically when connected. The refresh button scans again. Selecting an available network enables the forward action.

- If already connected to Wi-Fi, proceeding skips the password and goes to Hardware Validation.
- An open network also proceeds directly to Hardware Validation.
- A secured network proceeds to the password step.

### 3. Wi-Fi Password

Shows the selected network name, accepts its password, and includes a show/hide password control. Connect submits the credentials. If the connection request fails, the wizard stays on this step and shows an error message.

### 4. Hardware Validation

Polls device connectivity checks every two seconds. Wi-Fi must be available, and the input requirement is satisfied by either the input jack or HDMI together with the video-detection process. The HDMI/video check is only shown when HDMI is detected. Proceed remains disabled until the required checks pass.

### 5. Device Association

Accepts the four-digit suffix of a Household ID (displayed with an `HH` prefix). Submit initiates assignment of this device to the household. A successful request proceeds to OTP verification; failures are shown as a toast.

### 6. Verify OTP

Accepts a four-digit one-time code sent to the registered mobile number. Verify submits the code along with the meter ID and household suffix. A successful verification proceeds to finalization; an unsuccessful one displays an error.

### 7. Finalizing Setup

Requests the household members from the backend and reports the sync result. On success, members are reloaded and the wizard closes. If the request fails, **Retry Connection** is offered.

## Main Application

The navigation rail provides Home, Add Guest, Notifications, and Settings. A Wi-Fi status button opens Settings > Connectivity. The guest icon displays the current guest count.

### Home: Household Member Grid

Displays household members as avatar tiles with their name, gender, and age. Selecting a tile toggles that member's active/watching state and updates the backend. A short debounce prevents accidental repeated toggles.

- Member declarations are disabled while the TV is off; a lock overlay explains this state.
- When remote mode is enabled, arrow keys move focus around the grid and the select/confirm action toggles the focused member.
- Active household members are also shown in the screensaver's **Watching Now** area while the TV is on.

### Add Guest

Adds a temporary guest to the guest list. The form accepts an age from 1 to 110 and a gender selection. The guest is created active, gets an automatically generated guest name and avatar seed, and is added to the active guest list. The UI currently limits the list to nine guests.

Guests are shown with avatar, age, and gender and can be removed using the close control on their avatar. The duration selector is hidden in the current interface; guest activity is described by the UI as lasting for the 24-hour cycle from 2 AM to 2 AM.

### Notifications

Lists notifications with a type icon, title, message, unread styling, and relative timestamp. Selecting a notification marks it read. Survey notifications open the Survey view; other notification types are simply marked read.

### Survey

Displays the question associated with a survey notification and either a set of answer choices or a text field, depending on the survey configuration. Users can submit or skip and return to Notifications. In the current frontend, answer handling displays a thank-you toast and logs the answer in the browser; it does not send the answer to a backend endpoint.

## Settings

Settings is a collection of subpanels. The back button on a subpanel returns to the Settings menu. Leaving Settings for another main view resets the selected panel to the menu.

### Settings Menu

Provides entries for Members, Avatar Style, Language, Location, Connectivity, Display Setting, Screensaver Wallpaper, System Info, and Power Options. Screensaver Wallpaper and System Info are hidden by default. System Info becomes visible after tapping the Settings title three times.

### Members

Shows each household member's name, gender, and age. Names can be edited inline; edits update the grid and are sent to the backend.

### Avatar Style

Selects the avatar appearance used for household members and guests. Available choices are Default Local, Adventurer, Bottts, Lorelei, Pixel Art, Avataaars, Micah, and Shapes. Changing the style refreshes the member grid.

### Language

Changes the interface language to English, Armenian, or Russian. Translations are applied to the UI and language-dependent notification content is refreshed.

### Location

Selects **Auto** or a supported Armenian city: Yerevan, Gyumri, Vanadzor, Vagharshapat, Abovyan, Kapan, Hrazdan, or Armavir. Auto attempts to detect the city from the internet. The selected location is used by the screensaver weather display.

### Connectivity

Shows the current Wi-Fi network and connection/internet status, scans available networks, and lists signal strength and saved/open/secured state. Selecting a network connects directly if open, or opens a password prompt for secured networks. The refresh button reloads the network list.

### Display Setting

- **Light Theme:** switches between light and dark themes.
- **Use Remote:** enables remote/keyboard navigation, including focus movement and selection.
- **Reduce Animations:** reduces UI animation effects.
- **Brightness:** sets display brightness to 10%, 25%, 50%, 75%, or 100% through the system API.

### Screensaver Wallpaper

Provides a QR code and upload URL for uploading a JPG, PNG, or WebP image from a phone. Shows the current custom wallpaper and provides an action to remove it and restore the system default. This panel is currently hidden from the Settings menu, but can be opened by calling its setting route in the UI.

### System Info

Shows the device identifier, local IP address, MAC address, software version, component software versions, and hardware status for Wi-Fi, GSM, USB audio, HDMI, and video detection. A refresh button reloads the information. This panel is hidden until the Settings title is tapped three times.

### Power Options

Provides a reboot confirmation flow and screen timeout choices of 15 seconds, 30 seconds, 1 minute, 2 minutes, or 5 minutes. Reboot uses a three-second countdown before requesting a system reboot. The current UI exposes reboot; although the shared confirmation handler supports shutdown, there is no shutdown button in this panel.

## Screensaver and Persistent Overlays

### Screensaver

Activates after the configured idle timeout (five minutes by default in settings). It displays a live 24-hour clock, date, weather for the configured location, and active household members when the TV is on. A custom wallpaper is used when one is configured. When the TV is off, the clock is emphasized and the active-member list is hidden. User interaction dismisses the screensaver and resets its idle timer.

### Active Member Reminder

When the TV is on and no household member is marked active, a prompt asks **Who's watching?** and offers **Identify Members Now**, which returns to Home. The prompt disappears after ten seconds and can reappear after one minute while the condition remains true. It is suppressed during onboarding and while the TV is off.

### Still Watching Reminder

When at least one member is active, a prompt appears after two hours without a fresh viewing declaration. **I'm Watching** starts a new two-hour interval. **End Session** clears the active household declaration and guest list.

### Wi-Fi Password Prompt, Dialogs, and Toasts

Secured Wi-Fi connections use a password popover with show/hide, Cancel, and Connect actions. Shared confirmation dialogs are used for actions such as reboot and validation errors. Toasts provide short-lived success, status, and error feedback.

## Keyboard and Remote Interaction

The app includes an on-screen keyboard for editable fields, including onboarding fields. Remote mode adds keyboard/remote focus navigation and is configurable under Display Setting. Navigation and interactive controls are also usable through their touch/click handlers.