import { Component, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { MatButtonModule } from "@angular/material/button";
import { MatFormFieldModule } from "@angular/material/form-field";
import { MatIconModule } from "@angular/material/icon";
import { MatListModule } from "@angular/material/list";
import { MatSelectModule } from "@angular/material/select";
import { MatSidenavModule } from "@angular/material/sidenav";
import { MatToolbarModule } from "@angular/material/toolbar";
import { ApiService } from "./api.service";
import { ChatComponent } from "./chat.component";
import type { Agent, Session } from "./models";

/**
 * The app shell: one chat window. The agent is picked from the selector in the
 * toolbar (not a separate list), mirroring the admin UI where the composer
 * settings choose the agent; switching agent shows that agent's newest
 * conversation. The left drawer lists the selected agent's past conversations.
 */
@Component({
  selector: "mc-app",
  standalone: true,
  imports: [
    CommonModule, FormsModule, ChatComponent,
    MatButtonModule, MatFormFieldModule, MatIconModule, MatListModule,
    MatSelectModule, MatSidenavModule, MatToolbarModule,
  ],
  template: `
    <mat-sidenav-container style="height: 100vh">
      <mat-sidenav mode="side" opened class="sidebar">
        <button mat-stroked-button style="margin: 8px" (click)="newChat()" [disabled]="!agent">
          <mat-icon>add</mat-icon> New chat
        </button>
        <h3>Chats</h3>
        <mat-nav-list>
          <a mat-list-item *ngFor="let s of sessions" [activated]="s.id === session?.id" (click)="session = s">
            <mat-icon matListItemIcon>chat</mat-icon>
            <span matListItemTitle>{{ s.title || 'New chat' }}</span>
          </a>
        </mat-nav-list>
      </mat-sidenav>

      <mat-sidenav-content style="display: flex; flex-direction: column; height: 100vh">
        <mat-toolbar color="primary">
          <span>MindConnect Chat</span>
          <span style="flex: 1"></span>
          <mat-form-field appearance="outline" subscriptSizing="dynamic" style="width: 220px" *ngIf="agents.length">
            <mat-label>Agent</mat-label>
            <mat-select [ngModel]="agent?.id" (ngModelChange)="switchAgent($event)">
              <mat-option *ngFor="let a of agents" [value]="a.id">{{ a.name }}</mat-option>
            </mat-select>
          </mat-form-field>
        </mat-toolbar>

        <mc-chat *ngIf="agent" [agent]="agent" [session]="session"
                 (sessionCreated)="onSessionCreated($event)"
                 style="display: flex; flex-direction: column; flex: 1; min-height: 0"></mc-chat>
      </mat-sidenav-content>
    </mat-sidenav-container>
  `,
})
export class AppComponent implements OnInit {
  agents: Agent[] = [];
  agent?: Agent;
  sessions: Session[] = [];
  session?: Session;

  constructor(private readonly api: ApiService) {}

  async ngOnInit(): Promise<void> {
    this.agents = await this.api.listAgents();
    this.agent = this.agents[0];
    if (this.agent) await this.loadSessions();
  }

  async switchAgent(agentId: string): Promise<void> {
    this.agent = this.agents.find((a) => a.id === agentId);
    this.session = undefined;
    await this.loadSessions();
  }

  async newChat(): Promise<void> {
    if (!this.agent) return;
    const created = await this.api.createSession(this.agent.id);
    await this.loadSessions();
    this.session = this.sessions.find((s) => s.id === created.id) ?? created;
  }

  onSessionCreated(created: Session): void {
    this.sessions = [created, ...this.sessions];
    this.session = created;
  }

  private async loadSessions(): Promise<void> {
    this.sessions = this.agent ? await this.api.listSessions(this.agent.id) : [];
    this.session = this.sessions[0];
  }
}
