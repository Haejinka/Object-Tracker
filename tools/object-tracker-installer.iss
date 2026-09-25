[Setup]
AppId={{EDB43236-D3CF-4E6E-85B0-A12572535831}
AppName=Object Tracker
AppVersion=0.1.0
AppPublisher=Object Tracker
DefaultDirName={userappdata}\Adobe\CEP\extensions\com.objecttracker.premiere
DefaultGroupName=Object Tracker
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=Object Tracker-Setup-0.1.0
VersionInfoVersion=0.1.0.0
VersionInfoProductName=Object Tracker
VersionInfoDescription=Object Tracker installer for Adobe Premiere Pro
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
Uninstallable=yes
UninstallDisplayName=Object Tracker for Premiere Pro
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\CSXS\*"; DestDir: "{app}\CSXS"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\css\*"; DestDir: "{app}\css"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\js\*"; DestDir: "{app}\js"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\jsx\*"; DestDir: "{app}\jsx"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\index.html"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docs\install-and-use.md"; DestDir: "{app}"; DestName: "README.md"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Adobe\CSXS.12"; ValueType: string; ValueName: "PlayerDebugMode"; ValueData: "1"

[Code]
function InitializeSetup(): Boolean;
begin
  Result := True;
end;
