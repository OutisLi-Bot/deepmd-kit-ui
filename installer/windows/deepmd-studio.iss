; SPDX-License-Identifier: LGPL-3.0-or-later
; Large, fully offline Windows installer for DeePMD Studio.

#ifndef AppVersion
  #define AppVersion "0.2.3"
#endif

#ifndef TargetTriple
  #define TargetTriple "x86_64-pc-windows-msvc"
#endif

#define DesktopRoot AddBackslash(SourcePath) + "..\.."
#define ReleaseDir DesktopRoot + "\target\" + TargetTriple + "\release"
#define RuntimeDir DesktopRoot + "\src-tauri\resources\runtime"

[Setup]
AppId={{D97AE353-D829-4EC9-9357-C6D7FBEDCC2D}
AppName=DeePMD Studio
AppVersion={#AppVersion}
AppVerName=DeePMD Studio {#AppVersion}
AppPublisher=DeepModeling
AppPublisherURL=https://deepmd-kit.readthedocs.io/
AppSupportURL=https://github.com/OutisLi-Bot/deepmd-kit-ui/issues
AppUpdatesURL=https://github.com/OutisLi-Bot/deepmd-kit-ui/releases
VersionInfoVersion={#AppVersion}
VersionInfoCompany=DeepModeling
VersionInfoDescription=DeePMD Studio offline installer
VersionInfoProductName=DeePMD Studio
DefaultDirName={localappdata}\Programs\DeePMD Studio
DefaultGroupName=DeePMD Studio
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
SetupIconFile={#DesktopRoot}\src-tauri\icons\icon.ico
WizardImageFile={#DesktopRoot}\installer\windows\wizard-image.png
WizardSmallImageFile={#DesktopRoot}\installer\windows\wizard-small-image.png
WizardImageBackColor=white
WizardSmallImageBackColor=white
UninstallDisplayIcon={app}\deepmd-studio.exe
OutputDir={#ReleaseDir}\bundle\inno
OutputBaseFilename=DeePMD-Studio-{#AppVersion}-Windows-x64-CUDA13-Setup
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes
DiskSpanning=no
UseSetupLdr=x64
WizardStyle=modern
WizardSizePercent=110
CloseApplications=yes
RestartApplications=no
SetupLogging=yes
UsePreviousAppDir=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#ReleaseDir}\deepmd-studio.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}\dpstudio.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#RuntimeDir}\*"; DestDir: "{app}\runtime"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#DesktopRoot}\scripts\runtime_manager.py"; DestDir: "{app}\runtime-manager"; Flags: ignoreversion
Source: "{#DesktopRoot}\python\deepmd_ui\bridge.py"; DestDir: "{app}\bridge"; DestName: "deepmd_ui_bridge.py"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\DeePMD Studio"; Filename: "{app}\deepmd-studio.exe"; WorkingDir: "{userdocs}"
Name: "{autodesktop}\DeePMD Studio"; Filename: "{app}\deepmd-studio.exe"; WorkingDir: "{userdocs}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\deepmd-studio.exe"; ValueType: string; ValueName: ""; ValueData: "{app}\deepmd-studio.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\deepmd-studio.exe"; ValueType: string; ValueName: "Path"; ValueData: "{app}"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\dpstudio.exe"; ValueType: string; ValueName: ""; ValueData: "{app}\dpstudio.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\dpstudio.exe"; ValueType: string; ValueName: "Path"; ValueData: "{app}"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\deepmd-studio.exe"; Description: "{cm:LaunchProgram,DeePMD Studio}"; Flags: nowait postinstall skipifsilent
