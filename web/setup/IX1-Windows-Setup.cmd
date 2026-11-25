<# : Raythink IX1 thermal camera - one-time Windows setup. Double-click to run.
@echo off
title IX1 thermal camera setup
fltmc >nul 2>&1 || (
  echo Asking for administrator permission...
  powershell -NoProfile -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
  exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText('%~f0'))"
echo.
pause
exit /b
#>


$ErrorActionPreference = 'Stop'
$HardwareId = 'USB\VID_3474&PID_1200'
$CertSubject = 'CN=IX1 thermal camera WinUSB (local; made by IX1-Windows-Setup)'
$Work = Join-Path $env:SystemRoot 'Temp\ix1-winusb'   # ASCII-only path, for the catalog tools

$Inf = @'
[Version]
Signature   = "$Windows NT$"
Class       = USBDevice
ClassGuid   = {88BAE032-5A81-49f0-BC3D-A4FF138216D6}
Provider    = %Provider%
CatalogFile = ix1_winusb.cat
DriverVer   = 11/25/2026,1.0.0.0
PnpLockdown = 1

[Manufacturer]
%Provider% = IX1, NTamd64, NTarm64, NTx86

[IX1.NTamd64]
%DeviceName% = IX1_Install, USB\VID_3474&PID_1200

[IX1.NTarm64]
%DeviceName% = IX1_Install, USB\VID_3474&PID_1200

[IX1.NTx86]
%DeviceName% = IX1_Install, USB\VID_3474&PID_1200

[IX1_Install]
Include = winusb.inf
Needs   = WINUSB.NT

[IX1_Install.Services]
Include = winusb.inf
Needs   = WINUSB.NT.Services

[IX1_Install.HW]
AddReg = IX1_AddReg

[IX1_AddReg]
HKR,,DeviceInterfaceGUIDs,0x10000,"{2ed5e6d1-5716-429a-9669-8f51b4ceba00}"

[Strings]
Provider   = "IX1 thermal camera (local setup)"
DeviceName = "Raythink IX1 thermal camera"
'@

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class IX1Setup {
    public delegate void ParseError(uint area, uint code, IntPtr line);

    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CryptCATCDFOpen(string path, ParseError cb);
    [DllImport("wintrust.dll", SetLastError = true)]
    static extern IntPtr CryptCATCDFEnumCatAttributes(IntPtr cdf, IntPtr prev, ParseError cb);
    [DllImport("wintrust.dll", SetLastError = true)]
    static extern IntPtr CryptCATCDFEnumMembersByCDFTagEx(IntPtr cdf, IntPtr prevTag, ParseError cb,
        ref IntPtr member, bool continueOnError, IntPtr reserved);
    [DllImport("wintrust.dll", SetLastError = true)]
    static extern IntPtr CryptCATCDFEnumAttributesWithCDFTag(IntPtr cdf, IntPtr tag, IntPtr member,
        IntPtr prev, ParseError cb);
    [DllImport("wintrust.dll", SetLastError = true)]
    static extern bool CryptCATCDFClose(IntPtr cdf);
    [DllImport("newdev.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool UpdateDriverForPlugAndPlayDevicesW(IntPtr hwnd, string hardwareId, string infPath,
        uint flags, out bool rebootRequired);

    static string errors = "";
    static void OnError(uint area, uint code, IntPtr line) {
        errors += string.Format("catalog error 0x{0:X} (area {1}) at: {2}\n", code, area, Marshal.PtrToStringUni(line));
    }

    public static void MakeCatalog(string cdfPath) {
        errors = "";
        ParseError cb = OnError;
        IntPtr cdf = CryptCATCDFOpen(cdfPath, cb);
        if (cdf == IntPtr.Zero) throw new Win32Exception();
        IntPtr attr = IntPtr.Zero;
        while ((attr = CryptCATCDFEnumCatAttributes(cdf, attr, cb)) != IntPtr.Zero) { }
        IntPtr tag = IntPtr.Zero, member = IntPtr.Zero;
        while ((tag = CryptCATCDFEnumMembersByCDFTagEx(cdf, tag, cb, ref member, true, IntPtr.Zero)) != IntPtr.Zero) {
            IntPtr a = IntPtr.Zero;
            while ((a = CryptCATCDFEnumAttributesWithCDFTag(cdf, tag, member, a, cb)) != IntPtr.Zero) { }
        }
        if (!CryptCATCDFClose(cdf)) throw new Win32Exception();
        GC.KeepAlive(cb);
        if (errors != "") throw new Exception(errors);
    }

    public static bool InstallDriver(string hardwareId, string infPath) {
        bool reboot;
        const uint INSTALLFLAG_FORCE = 1; // use this driver even though Windows ranks its own composite driver higher
        if (!UpdateDriverForPlugAndPlayDevicesW(IntPtr.Zero, hardwareId, infPath, INSTALLFLAG_FORCE, out reboot))
            throw new Win32Exception();
        return reboot;
    }
}
'@

function Find-Camera {
    Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue |
        Where-Object { $_.InstanceId -like 'USB\VID_3474&PID_1200\*' } | Select-Object -First 1
}

function Get-DriverService($dev) {
    (Get-PnpDeviceProperty -InstanceId $dev.InstanceId -KeyName DEVPKEY_Device_Service -ErrorAction SilentlyContinue).Data
}

function Install-IX1 {
    Write-Host ''
    Write-Host 'Raythink IX1 thermal camera - one-time setup' -ForegroundColor Cyan
    Write-Host ''

    $cam = Find-Camera
    if (-not $cam) {
        Write-Host 'Plug the camera in now (waiting)...'
        while (-not ($cam = Find-Camera)) { Start-Sleep -Seconds 1 }
    }
    if ((Get-DriverService $cam) -eq 'WinUSB') {
        Write-Host 'Already set up - nothing to do. Open the website and press "Connect camera".' -ForegroundColor Green
        return
    }

    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $Work | Out-Null
    $infPath = Join-Path $Work 'ix1_winusb.inf'
    $catPath = Join-Path $Work 'ix1_winusb.cat'
    $cdfPath = Join-Path $Work 'ix1_winusb.cdf'
    Set-Content -LiteralPath $infPath -Value $Inf -Encoding Ascii

    Write-Host 'Building the driver package...'
    $os = '2:6.1,2:6.2,2:6.3,2:10.0'
    $cdf = @(
        '[CatalogHeader]'
        "Name=$catPath"
        'CatalogVersion=2'
        'HashAlgorithms=SHA256'
        "CATATTR1=0x10010001:OSAttr:$os"
        ''
        '[CatalogFiles]'
        "<HASH>$infPath=$infPath"
        "<HASH>${infPath}ATTR1=0x10010001:OSAttr:$os"
    )
    Set-Content -LiteralPath $cdfPath -Value $cdf -Encoding Ascii
    [IX1Setup]::MakeCatalog($cdfPath)

    Write-Host 'Signing it with a certificate trusted on this PC only...'
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $CertSubject `
        -CertStoreLocation Cert:\LocalMachine\My -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
        -NotAfter (Get-Date).AddYears(30)
    try {
        $public = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cert.RawData)
        foreach ($storeName in 'Root', 'TrustedPublisher') {
            $store = [System.Security.Cryptography.X509Certificates.X509Store]::new($storeName, 'LocalMachine')
            $store.Open('ReadWrite')
            $store.Add($public)
            $store.Close()
        }
        $sig = Set-AuthenticodeSignature -LiteralPath $catPath -Certificate $cert -HashAlgorithm SHA256
        if ($sig.Status -ne 'Valid') { throw "Signing the catalog failed: $($sig.StatusMessage)" }
    } finally {
        Remove-Item -LiteralPath "Cert:\LocalMachine\My\$($cert.Thumbprint)" -DeleteKey
    }

    Write-Host 'Installing the WinUSB driver for the camera...'
    $reboot = [IX1Setup]::InstallDriver($HardwareId, $infPath)

    Start-Sleep -Seconds 2
    $cam = Find-Camera
    if ($cam -and (Get-DriverService $cam) -eq 'WinUSB') {
        Write-Host ''
        Write-Host 'Done! Open the website in Chrome or Edge and press "Connect camera".' -ForegroundColor Green
    } elseif ($reboot) {
        Write-Host 'Done, but Windows wants a restart before the camera can be used.' -ForegroundColor Yellow
    } else {
        Write-Host 'The driver was installed. If the website cannot open the camera, replug it.' -ForegroundColor Yellow
    }
}

try {
    Install-IX1
} catch {
    Write-Host ''
    Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'As a fallback, Zadig (https://zadig.akeo.ie) can install WinUSB for "IX1 Go Pro (Composite Parent)".'
} finally {
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
}
