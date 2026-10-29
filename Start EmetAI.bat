@echo off
rem EmetAI — double-click this to start.
rem
rem Everything lives in launcher\start-emetai.ps1; this file exists so the
rem operator has one obvious thing to click, and so PowerShell's execution
rem policy cannot refuse to run it on a fresh Windows machine.
title EmetAI
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\start-emetai.ps1"
