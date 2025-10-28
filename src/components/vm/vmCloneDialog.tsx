/*
 * This file is part of Cockpit.
 *
 * Copyright (C) 2020 Red Hat, Inc.
 *
 * Cockpit is free software; you can redistribute it and/or modify it
 * under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation; either version 2.1 of the License, or
 * (at your option) any later version.
 *
 * Cockpit is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with Cockpit; If not, see <http://www.gnu.org/licenses/>.
 */

import cockpit from 'cockpit';
import React, { useState, useEffect } from 'react';

import type { ConnectionName } from '../../types';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox";
import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import { HelperText, HelperTextItem } from "@patternfly/react-core/dist/esm/components/HelperText";

import { FormHelper } from 'cockpit-components-form-helper.jsx';
import { isEmpty, isObjectEmpty } from '../../helpers.js';
import { ModalError } from 'cockpit-components-inline-notification.jsx';
import { useDialogs } from 'dialogs.jsx';

import "./vmCloneDialog.css";
const _ = cockpit.gettext;

interface Validation {
    name?: string;
}

interface DialogError {
    dialogError?: string;
}

interface FileSystemInfo {
    hasReflink: boolean;
    fsType: string;
}

export const CloneDialog = ({
    name,
    connectionName
} : {
    name: string,
    connectionName: ConnectionName,
}) => {
    const Dialogs = useDialogs();
    const [newVmName, setNewVmName] = useState(name + '-clone');
    const [inProgress, setInProgress] = useState(false);
    const [virtCloneOutput, setVirtCloneOutput] = useState('');
    const [error, dialogErrorSet] = useState<DialogError>({});
    const [fsInfo, setFsInfo] = useState<FileSystemInfo>({ hasReflink: false, fsType: '' });
    const [useReflink, setUseReflink] = useState(false);
    const [isCheckingFs, setIsCheckingFs] = useState(true);

    // 检测文件系统类型和reflink功能
    useEffect(() => {
        setIsCheckingFs(true);
        // 获取VM存储路径
        cockpit.spawn(
            ["virsh", "--connect", "qemu:///" + connectionName, "domblklist", name],
            { superuser: connectionName === "system" ? "try" : false }
        ).then(output => {
            const lines = output.split('\n');
            // 跳过标题行，查找第一个磁盘路径
            let diskPath = '';
            for (let i = 1; i < lines.length; i++) {
                const parts = lines[i].trim().split(/\s+/);
                if (parts.length >= 2 && parts[1] && parts[1] !== '-') {
                    diskPath = parts[1];
                    break;
                }
            }

            if (diskPath) {
                // 获取磁盘所在的文件系统类型
                return cockpit.spawn(
                    ["df", "--output=fstype", diskPath],
                    { superuser: connectionName === "system" ? "try" : false }
                ).then(fsOutput => {
                    const fsLines = fsOutput.split('\n');
                    // 第一行是标题，第二行是文件系统类型
                    if (fsLines.length >= 2) {
                        const fsType = fsLines[1].trim();
                        
                        // 检查是否支持reflink
                        if (fsType === 'xfs' || fsType === 'btrfs') {
                            return cockpit.spawn(
                                ["cp", "--reflink=always", diskPath, diskPath + ".test"],
                                { superuser: connectionName === "system" ? "try" : false, err: "message" }
                            ).then(() => {
                                // 清理测试文件
                                cockpit.spawn(
                                    ["rm", "-f", diskPath + ".test"],
                                    { superuser: connectionName === "system" ? "try" : false }
                                );
                                setFsInfo({ hasReflink: true, fsType });
                                setUseReflink(true);
                            }).catch(() => {
                                setFsInfo({ hasReflink: false, fsType });
                            });
                        } else {
                            setFsInfo({ hasReflink: false, fsType });
                        }
                    }
                }).catch(() => {
                    console.log("Failed to get filesystem type");
                });
            }
        }).catch(err => {
            console.log("Failed to get VM disk path:", err);
        }).finally(() => {
            setIsCheckingFs(false);
        });
    }, [name, connectionName]);

    function validateParams() {
        const validation: Validation = {};
        if (isEmpty(newVmName.trim()))
            validation.name = _("Name must not be empty");

        return validation;
    }

    function onClone() {
        const validation = validateParams();
        if (!isObjectEmpty(validation)) {
            setInProgress(false);
            return;
        }

        setInProgress(true);
        
        // 构建命令参数
        const cloneArgs = [
            "virt-clone", "--connect", "qemu:///" + connectionName,
            "--original", name, "--name", newVmName,
        ];
        
        // 如果支持并选择了reflink，添加reflink选项
        if (useReflink && fsInfo.hasReflink) {
            cloneArgs.push("--reflink");
        } else {
            cloneArgs.push("--auto-clone");
        }
        
        return cockpit.spawn(
            cloneArgs,
            {
                pty: true,
                ...(connectionName === "system" ? { superuser: "try" } : { })
            })
                .stream(setVirtCloneOutput)
                .then(Dialogs.close, () => {
                    setInProgress(false);
                    dialogErrorSet({ dialogError: cockpit.format(_("Failed to clone VM $0"), name) });
                });
    }

    const validationFailed = validateParams();
    return (
        <Modal position="top" variant="small" isOpen onClose={Dialogs.close}>
            <ModalHeader title={cockpit.format(_("Create a clone VM based on $0"), name)} />
            <ModalBody>
                <Form onSubmit={e => {
                    e.preventDefault();
                    onClone();
                }}
                isHorizontal>
                    {error.dialogError && <ModalError dialogError={error.dialogError} dialogErrorDetail={virtCloneOutput} />}
                    <FormGroup label={_("Name")} fieldId="vm-name"
                               id="vm-name-group">
                        <TextInput id='vm-name'
                                   validated={validationFailed.name ? "error" : "default"}
                                   value={newVmName}
                                   onChange={(_, value) => setNewVmName(value)} />
                        <FormHelper helperTextInvalid={validationFailed.name} />
                    </FormGroup>
                    
                    {isCheckingFs ? (
                        <FormGroup label={_("Reflink copy")} fieldId="vm-reflink">
                            <div>{_("Checking filesystem support...")}</div>
                        </FormGroup>
                    ) : fsInfo.hasReflink ? (
                        <FormGroup label={_("Reflink copy")} fieldId="vm-reflink">
                            <Checkbox
                                id='vm-reflink-checkbox'
                                isChecked={useReflink}
                                onChange={checked => setUseReflink(checked)}
                                label={_("Use reflink for faster, space-efficient cloning")}
                            />
                            <HelperText>
                                <HelperTextItem>
                                    {cockpit.format(_("Detected $0 filesystem with reflink support"), fsInfo.fsType)}
                                </HelperTextItem>
                            </HelperText>
                        </FormGroup>
                    ) : fsInfo.fsType === 'xfs' || fsInfo.fsType === 'btrfs' ? (
                        <FormGroup label={_("Reflink copy")} fieldId="vm-reflink">
                            <div>
                                {cockpit.format(_("$0 filesystem detected but reflink is not enabled"), fsInfo.fsType)}
                            </div>
                        </FormGroup>
                    ) : fsInfo.fsType ? (
                        <FormGroup label={_("Reflink copy")} fieldId="vm-reflink">
                            <div>
                                {cockpit.format(_("$0 filesystem does not support reflink"), fsInfo.fsType)}
                            </div>
                        </FormGroup>
                    ) : null}
                </Form>
            </ModalBody>
            <ModalFooter>
                {isObjectEmpty(error) && virtCloneOutput && <code className="vm-clone-virt-clone-output">{virtCloneOutput}</code>}
                <Button variant='primary'
                        isDisabled={inProgress || !isObjectEmpty(validationFailed)}
                        isLoading={inProgress}
                        onClick={onClone}>
                    {_("Clone")}
                </Button>
                <Button variant='link' onClick={Dialogs.close}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
