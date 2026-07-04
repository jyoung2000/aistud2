; Neuclip Studio — Windows installer (Inno Setup 6).
; A real setup wizard (welcome → folder → progress bar → finish), Start-menu entry,
; uninstaller, and the .neuclip file association so project files open in the app.
;
; Build (after `python sidecar/build_app.py` produced the onedir app):
;   iscc installer\windows.iss
; Output: installer\out\Neuclip-Studio-Setup.exe
;
; The GPU build installs side-by-side by passing:
;   iscc /DAppSrc="..\sidecar\dist\Neuclip Studio GPU" /DAppEdition=" GPU" installer\windows.iss

#ifndef AppSrc
#define AppSrc "..\sidecar\dist\Neuclip Studio"
#endif
#ifndef AppEdition
#define AppEdition ""
#endif
#define AppName "Neuclip Studio" + AppEdition
#define AppExe "Neuclip Studio" + AppEdition + ".exe"
#ifndef AppVersion
#define AppVersion "0.9.0"
#endif

[Setup]
; edition suffix keeps CPU + GPU installs (and their uninstallers) side-by-side
AppId={{7E1B0C2A-90D4-4B7B-B7B7-1F8B6C5B21A0}{#AppEdition}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=Neuclip
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
UninstallDisplayIcon={app}\{#AppExe}
DisableProgramGroupPage=yes
; per-user install by default → no UAC prompt, installs like modern consumer apps
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
WizardStyle=modern
SetupIconFile=..\sidecar\build_assets\neuclip.ico
Compression=lzma2
SolidCompression=yes
OutputDir=out
OutputBaseFilename=Neuclip-Studio-Setup{#AppEdition}
ChangesAssociations=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "assoc"; Description: "Open .&neuclip project files with {#AppName}"; GroupDescription: "File associations:"

[Files]
Source: "{#AppSrc}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
; .neuclip → open with the app (per-user classes; no admin needed)
Root: HKA; Subkey: "Software\Classes\.neuclip"; ValueType: string; ValueData: "NeuclipStudio.Project"; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\NeuclipStudio.Project"; ValueType: string; ValueData: "Neuclip Studio project"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\NeuclipStudio.Project\DefaultIcon"; ValueType: string; ValueData: "{app}\{#AppExe},0"; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\NeuclipStudio.Project\shell\open\command"; ValueType: string; ValueData: """{app}\{#AppExe}"" ""%1"""; Tasks: assoc

[Run]
Filename: "{app}\{#AppExe}"; Description: "Launch {#AppName}"; Flags: nowait postinstall skipifsilent
