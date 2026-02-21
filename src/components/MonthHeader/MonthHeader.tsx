import React, { useEffect } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	withSpring,
} from "react-native-reanimated";
import { theme } from "@theme";

type Props = {
	title: string;
	total: number;
	collapsed: boolean;
	onToggle: () => void;
};

export default function MonthHeader({
	title,
	total,
	collapsed,
	onToggle,
}: Props) {
	const isExpanded = !collapsed;

	const scale = useSharedValue(1);
	const progress = useSharedValue(isExpanded ? 1 : 0);

	useEffect(() => {
		progress.value = withTiming(isExpanded ? 1 : 0, {
			duration: 220,
		});
	}, [isExpanded]);

	const leftLine = useAnimatedStyle(() => ({
		transform: [
			{ rotate: `${progress.value * 45 - 45}deg` },
			{ translateY: progress.value * 2 },
		],
	}));

	const rightLine = useAnimatedStyle(() => ({
		transform: [
			{ rotate: `${45 - progress.value * 45}deg` },
			{ translateY: progress.value * 2 },
		],
	}));

	const pressStyle = useAnimatedStyle(() => ({
		transform: [{ scale: scale.value }],
	}));

	return (
		<Animated.View
			style={[
				{
					backgroundColor: theme.colors.background,
					paddingVertical: 14,
					paddingHorizontal: 16,
					borderBottomWidth: 1,
					borderBottomColor: "#e5e5e5",
				},
				pressStyle,
			]}
		>
			<TouchableOpacity
				activeOpacity={0.9}
				onPress={() => {
					scale.value = withSpring(0.97, { damping: 15 });
					setTimeout(() => {
						scale.value = withSpring(1);
					}, 120);

					onToggle();
				}}
				style={{
					flexDirection: "row",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<View>
					<Text
						style={{
							fontSize: 13,
							color: theme.colors.textSecondary,
							letterSpacing: 1,
						}}
					>
						{title.toUpperCase()}
					</Text>

					<Text
						style={{
							fontSize: 16,
							fontWeight: "700",
							color: total >= 0 ? theme.colors.income : theme.colors.expense,
						}}
					>
						₹ {total}
					</Text>
				</View>

				<View
					style={{
						width: 20,
						height: 20,
						alignItems: "center",
						justifyContent: "center",
					}}
				>
					<Animated.View
						style={[
							{
								position: "absolute",
								width: 12,
								height: 2,
								backgroundColor: theme.colors.textSecondary,
								borderRadius: 1,
							},
							leftLine,
						]}
					/>
					<Animated.View
						style={[
							{
								position: "absolute",
								width: 12,
								height: 2,
								backgroundColor: theme.colors.textSecondary,
								borderRadius: 1,
							},
							rightLine,
						]}
					/>
				</View>
			</TouchableOpacity>
		</Animated.View>
	);
}
